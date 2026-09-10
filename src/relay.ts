import { DurableObject } from "cloudflare:workers";
import {
  discoverBroadcast,
  pollLiveChat,
  type RelayCycleRuntime,
} from "./relay-cycle";
import { errorMessage, isFatalYouTubeError } from "./relay-errors";
import { flushRelaySnapshot } from "./relay-r2";
import { nextRelayAlarm } from "./relay-schedule";
import { TWITCH_EVENT_TYPES, twitchConfig, type TwitchDelivery } from "./twitch";
import {
  acceptTwitchDelivery,
  applyTwitchDelivery,
  countComments,
  deleteRunComments,
  deleteRunEvents,
  getCommentDelta,
  getSimpleCommentDelta,
  getSimpleCommentDeltaFromSnapshot,
  initializeRelayStorage,
  listComments,
  loadRelayState,
  saveRelayState,
} from "./relay-storage";
import {
  createRunningState,
  readRelayConfig,
  toRelayStatus,
  type CommentDeltaResponse,
  type RelayState,
  type RelayStatus,
  type SimpleCommentDeltaResponse,
} from "./types";
import {
  findBroadcastByVideoId,
  parseChannelReference,
  parseVideoId,
  resolveChannel,
  YouTubeApiError,
} from "./youtube";

interface FlushResult {
  state: RelayState;
  success: boolean;
}

export class YouTubeChatRelay extends DurableObject<Env> {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      initializeRelayStorage(this.ctx.storage);
    });
  }

  async start(channelRef: string): Promise<RelayStatus> {
    return this.runSerially(() => this.startInternal(channelRef), true);
  }

  async startE2E(channelRef: string, videoId: string): Promise<RelayStatus> {
    return this.runSerially(() => this.startE2EInternal(channelRef, videoId), true);
  }

  async stop(reason = "manual"): Promise<RelayStatus> {
    return this.runSerially(() => this.stopInternal(reason), true);
  }

  async status(): Promise<RelayStatus> {
    return this.runSerially(() => this.currentStatus());
  }

  async startTwitch(): Promise<RelayStatus> {
    return this.runSerially(async () => {
      const config = twitchConfig(this.env);
      let state = this.loadState();
      if (!state.enabled && !state.twitch.enabled) {
        await this.archiveAndClearRun(state);
        state = { ...createRunningState(""), enabled: false, phase: "stopped", channelRef: null,
          nextActionAt: null, twitch: state.twitch };
      }
      const sameChannel = state.twitch.broadcasterId === config.broadcasterId;
      const subscriptions = sameChannel ? state.twitch.subscriptions : {};
      state = { ...state, twitch: { ...state.twitch, enabled: true,
        channel: config.channel, broadcasterId: config.broadcasterId, subscriptions,
        phase: TWITCH_EVENT_TYPES.every((type) => subscriptions[type]) ? "running" : "waiting",
        startedAt: state.twitch.enabled && sameChannel ? state.twitch.startedAt : new Date().toISOString(),
        lastError: null, lastReceivedAt: state.twitch.enabled && sameChannel ? state.twitch.lastReceivedAt : null,
      } };
      this.saveState(state);
      return this.statusFor((await this.safeFlushSnapshot(state, true)).state);
    }, true);
  }

  async stopTwitch(): Promise<RelayStatus> {
    return this.runSerially(async () => {
      const state = this.loadState();
      const stopped: RelayState = { ...state, twitch: { ...state.twitch, enabled: false, phase: "stopped" } };
      this.saveState(stopped);
      return this.statusFor((await this.safeFlushSnapshot(stopped, true)).state);
    }, true);
  }

  async receiveTwitch(delivery: TwitchDelivery): Promise<void> {
    // ACK after durable enqueue, without waiting on YouTube HTTP or R2 writes.
    await this.ctx.storage.transaction(async (transaction) => {
      if (!acceptTwitchDelivery(this.ctx.storage, delivery.id)) return;
      this.ctx.storage.sql.exec("INSERT INTO twitch_pending (delivery) VALUES (?)", JSON.stringify(delivery));
      const alarm = await transaction.getAlarm();
      if (alarm === null || alarm > Date.now()) await transaction.setAlarm(Date.now());
    });
  }

  private drainTwitch(all = false): void {
    this.ctx.storage.transactionSync(() => {
      const pending = this.ctx.storage.sql.exec<{ seq: number; delivery: string }>(
        "SELECT seq, delivery FROM twitch_pending ORDER BY seq LIMIT ?", all ? -1 : 200,
      ).toArray();
      for (const row of pending) {
        const delivery = JSON.parse(row.delivery) as TwitchDelivery;
        this.ctx.storage.sql.exec("DELETE FROM twitch_pending WHERE seq = ?", row.seq);
        let state = this.loadState();
        const twitch = { ...state.twitch, subscriptions: { ...state.twitch.subscriptions } };
        if (delivery.kind === "webhook_callback_verification") {
          if (twitch.broadcasterId !== delivery.broadcasterId) twitch.subscriptions = {};
          twitch.broadcasterId = delivery.broadcasterId;
          twitch.channel = this.env.DEFAULT_TWITCH_CHANNEL.trim().toLowerCase();
          twitch.subscriptions[delivery.type] = delivery.subscriptionId;
          if (twitch.enabled && TWITCH_EVENT_TYPES.every((type) => twitch.subscriptions[type])) {
            twitch.phase = "running";
            twitch.lastError = null;
          }
        } else {
          if (twitch.broadcasterId !== delivery.broadcasterId ||
              twitch.subscriptions[delivery.type] !== delivery.subscriptionId) continue;
          if (delivery.kind === "revocation") {
            delete twitch.subscriptions[delivery.type];
            twitch.phase = twitch.enabled ? "error" : "stopped";
            twitch.lastError = `Twitch: ${delivery.type} (${delivery.reason})。購読を再設定してください。`;
          } else {
            if (!twitch.enabled || Date.parse(delivery.timestamp) < Date.parse(twitch.startedAt ?? "")) continue;
            applyTwitchDelivery(this.ctx.storage, state.runId, delivery);
            twitch.lastReceivedAt = new Date().toISOString();
          }
        }
        // Registering webhooks before the first session must not replace the pre-live R2 snapshot.
        if (state.startedAt !== null) {
          twitch.flushAt ??= new Date(Math.max(Date.now(),
            (Date.parse(state.lastFlushAt ?? "") || 0) + readRelayConfig(this.env).r2FlushIntervalMs)).toISOString();
        }
        state = { ...state, twitch, updatedAt: new Date().toISOString() };
        this.saveState(state);
      }
    });
  }

  async commentsDelta(
    clientStreamId: string | null,
    after: number | null,
    limit: number,
  ): Promise<CommentDeltaResponse> {
    return this.runSerially(() => {
      const state = this.loadState();
      return getCommentDelta(
        this.ctx.storage,
        state.runId,
        clientStreamId,
        after,
        limit,
      );
    });
  }

  async commentsDeltaSimple(
    limit: number,
  ): Promise<SimpleCommentDeltaResponse> {
    return this.runSerially(async () => {
      const state = this.loadState();
      const delta = getSimpleCommentDelta(this.ctx.storage, state.runId, limit);
      if (state.enabled || state.twitch.enabled || delta.events.length > 0) {
        return delta;
      }

      const config = readRelayConfig(this.env);
      const object = await this.env.COMMENTS_BUCKET.get(config.currentObjectKey);
      if (object === null) {
        return delta;
      }

      try {
        const snapshot = await object.json<unknown>();
        if (!Array.isArray(snapshot)) {
          return delta;
        }
        return getSimpleCommentDeltaFromSnapshot(
          snapshot.filter(isExportedComment),
          limit,
        );
      } catch (error) {
        this.log("simple_delta_snapshot_error", {
          message: errorMessage(error),
        });
        return delta;
      }
    });
  }

  override async alarm(): Promise<void> {
    await this.runSerially(async () => {
      let state = this.loadState();
      if (state.twitch.flushAt !== null && Date.parse(state.twitch.flushAt) <= Date.now()) {
        state = (await this.safeFlushSnapshot(state, true)).state;
      }
      if (!state.enabled) {
        if (state.lastError?.startsWith("R2:") === true && Date.parse(state.nextActionAt ?? "") <= Date.now()) {
          const flush = await this.safeFlushSnapshot(state, true);
          if (flush.success) {
            await this.ctx.storage.deleteAlarm();
          }
        }
        return;
      }

      // A Twitch flush alarm may fire earlier than YouTube's required polling interval.
      if (Date.parse(state.nextActionAt ?? "") > Date.now()) return;

      try {
        if (state.liveChatId === null) {
          await discoverBroadcast(this.cycleRuntime(), state);
        } else {
          await pollLiveChat(this.cycleRuntime(), state);
        }
      } catch (error) {
        await this.handleCycleError(state.runId, error);
      }
    });
  }

  private async startInternal(rawChannelRef: string): Promise<RelayStatus> {
    const channelRef = rawChannelRef.trim();
    parseChannelReference(channelRef);

    let current = this.loadState();
    const now = new Date().toISOString();

    if (current.enabled && current.channelRef === channelRef) {
      const shouldRediscover = current.liveChatId === null;
      current = {
        ...current,
        phase: shouldRediscover ? "discovering" : current.phase,
        updatedAt: now,
        nextActionAt: shouldRediscover ? now : current.nextActionAt,
        lastError: shouldRediscover ? null : current.lastError,
        consecutiveErrors: shouldRediscover ? 0 : current.consecutiveErrors,
      };
      this.saveState(current);
      if (shouldRediscover) {
        await this.ctx.storage.setAlarm(Date.now());
      }
      current = (await this.safeFlushSnapshot(current, true)).state;
      this.log("relay_start_refreshed", {
        runId: current.runId,
        channelId: current.channelId,
        videoId: current.videoId,
        rediscoveryRequested: shouldRediscover,
      });
      return this.statusFor(current);
    }

    if (!current.twitch.enabled) await this.archiveAndClearRun(current);

    let next = createRunningState(channelRef, now);
    next.twitch = current.twitch;
    if (current.twitch.enabled) {
      next.runId = current.runId;
      next.startedAt = current.startedAt;
    }
    this.saveState(next);
    await this.ctx.storage.setAlarm(Date.now());
    next = (await this.safeFlushSnapshot(next, true)).state;

    this.log("relay_started", {
      runId: next.runId,
      channelRef,
    });
    return this.statusFor(next);
  }

  private async startE2EInternal(
    rawChannelRef: string,
    rawVideoId: string,
  ): Promise<RelayStatus> {
    const channelRef = rawChannelRef.trim();
    parseChannelReference(channelRef);
    const videoId = parseVideoId(rawVideoId);

    const channel = await resolveChannel(this.env.YOUTUBE_API_KEY, channelRef);
    const broadcast = await findBroadcastByVideoId(
      this.env.YOUTUBE_API_KEY,
      videoId,
      channel.id,
    );
    let current = this.loadState();
    const now = new Date().toISOString();

    if (current.enabled && current.videoId === videoId) {
      current = {
        ...current,
        phase: "running",
        channelRef,
        channelId: channel.id,
        channelTitle: channel.title,
        videoTitle: broadcast.title,
        liveChatId: broadcast.liveChatId,
        liveStartedAt: broadcast.actualStartTime,
        lastError: null,
        consecutiveErrors: 0,
        updatedAt: now,
        nextActionAt: now,
      };
      this.saveState(current);
      await this.ctx.storage.setAlarm(Date.now());
      current = (await this.safeFlushSnapshot(current, true)).state;
      this.log("relay_e2e_start_refreshed", {
        runId: current.runId,
        channelId: channel.id,
        videoId,
      });
      return this.statusFor(current);
    }

    if (!current.twitch.enabled) await this.archiveAndClearRun(current);

    let next: RelayState = {
      ...createRunningState(channelRef, now),
      phase: "running",
      channelId: channel.id,
      channelTitle: channel.title,
      videoId: broadcast.videoId,
      videoTitle: broadcast.title,
      liveChatId: broadcast.liveChatId,
      liveStartedAt: broadcast.actualStartTime,
      twitch: current.twitch,
    };
    if (current.twitch.enabled) {
      next.runId = current.runId;
      next.startedAt = current.startedAt;
    }
    this.saveState(next);
    await this.ctx.storage.setAlarm(Date.now());
    next = (await this.safeFlushSnapshot(next, true)).state;
    this.log("relay_e2e_started", {
      runId: next.runId,
      channelId: channel.id,
      videoId,
    });
    return this.statusFor(next);
  }

  private async archiveAndClearRun(state: RelayState): Promise<void> {
    const oldRunId = state.runId;
    const oldCommentCount = countComments(this.ctx.storage, oldRunId);
    let oldArchived = oldCommentCount === 0;
    if (oldCommentCount > 0) {
      const flush = await this.safeFlushSnapshot(state, true);
      oldArchived = flush.success && (flush.state.videoId !== null || flush.state.twitch.channel !== null);
    }

    if (oldArchived) {
      deleteRunComments(this.ctx.storage, oldRunId);
      deleteRunEvents(this.ctx.storage, oldRunId);
    }
  }

  private async stopInternal(reason: string): Promise<RelayStatus> {
    let state = this.loadState();
    if (!state.enabled) {
      await this.ctx.storage.deleteAlarm();
      state = (await this.safeFlushSnapshot(state, true)).state;
      return this.statusFor(state);
    }

    const now = new Date().toISOString();
    state = {
      ...state,
      enabled: false,
      phase: "stopped",
      stoppedAt: now,
      stopReason: reason,
      updatedAt: now,
      nextActionAt: null,
      consecutiveErrors: 0,
    };
    this.saveState(state);
    await this.ctx.storage.deleteAlarm();
    state = (await this.safeFlushSnapshot(state, true)).state;

    this.log("relay_stopped", {
      runId: state.runId,
      reason,
      videoId: state.videoId,
      commentCount: countComments(this.ctx.storage, state.runId),
    });
    return this.statusFor(state);
  }

  private async handleCycleError(
    runId: string,
    error: unknown,
  ): Promise<void> {
    let state = this.requireCurrentRun(runId);
    if (state === null) {
      return;
    }

    const message = errorMessage(error);
    if (error instanceof YouTubeApiError) {
      if (
        state.liveChatId !== null &&
        error.hasReason("liveChatEnded", "liveChatNotFound")
      ) {
        const now = new Date().toISOString();
        state = {
          ...state,
          enabled: false,
          phase: "stopped",
          stoppedAt: now,
          stopReason: "youtube-ended",
          lastError: null,
          updatedAt: now,
          nextActionAt: null,
        };
        this.saveState(state);
        await this.ctx.storage.deleteAlarm();
        await this.safeFlushSnapshot(state, true);
        return;
      }

      if (error.hasReason("pageTokenInvalid")) {
        const nextAlarmAt = Date.now() + 2000;
        state = {
          ...state,
          phase: "running",
          nextPageToken: null,
          lastError: "YouTube のページトークンを再取得します。",
          updatedAt: new Date().toISOString(),
          nextActionAt: new Date(nextAlarmAt).toISOString(),
        };
        this.saveState(state);
        await this.ctx.storage.setAlarm(nextAlarmAt);
        await this.safeFlushSnapshot(state, true);
        return;
      }

      if (isFatalYouTubeError(error)) {
        await this.failAndStop(state, `YouTube API: ${message}`);
        return;
      }
    }

    const consecutiveErrors = Math.min(state.consecutiveErrors + 1, 12);
    const backoffMs = Math.min(
      300_000,
      2000 * 2 ** Math.min(consecutiveErrors - 1, 7),
    );
    const nextAlarmAt = Date.now() + backoffMs;
    state = {
      ...state,
      phase: "error",
      lastError: message,
      consecutiveErrors,
      updatedAt: new Date().toISOString(),
      nextActionAt: new Date(nextAlarmAt).toISOString(),
    };
    this.saveState(state);
    await this.ctx.storage.setAlarm(nextAlarmAt);
    await this.safeFlushSnapshot(state, true);
    this.log("relay_cycle_error", {
      runId,
      message,
      consecutiveErrors,
      nextActionAt: state.nextActionAt,
    });
  }

  private async failAndStop(
    state: RelayState,
    message: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const failed: RelayState = {
      ...state,
      enabled: false,
      phase: "error",
      stoppedAt: now,
      stopReason: "fatal-error",
      lastError: message,
      updatedAt: now,
      nextActionAt: null,
    };
    this.saveState(failed);
    await this.ctx.storage.deleteAlarm();
    await this.safeFlushSnapshot(failed, true);
    this.log("relay_fatal_error", {
      runId: failed.runId,
      message,
    });
  }

  private async safeFlushSnapshot(
    state: RelayState,
    force: boolean,
  ): Promise<FlushResult> {
    if (!force) {
      const interval = readRelayConfig(this.env).r2FlushIntervalMs;
      const lastFlushAt = Date.parse(state.lastFlushAt ?? "");
      if (
        state.lastFlushAt !== null &&
        !Number.isNaN(lastFlushAt) &&
        Date.now() - lastFlushAt < interval
      ) {
        return { state, success: true };
      }
    }

    try {
      return {
        state: await this.flushSnapshot(state),
        success: true,
      };
    } catch (error) {
      const fresh = this.loadState();
      if (fresh.runId !== state.runId) {
        return { state: fresh, success: false };
      }

      const retryAt = fresh.enabled ? null : Date.now() + 30_000;
      const failed = {
        ...fresh,
        twitch: { ...fresh.twitch, flushAt: fresh.twitch.flushAt === null ? null : new Date(Date.now() + 30_000).toISOString() },
        lastError: `R2: ${errorMessage(error)}`,
        updatedAt: new Date().toISOString(),
        nextActionAt:
          retryAt === null ? fresh.nextActionAt : new Date(retryAt).toISOString(),
      };
      this.saveState(failed);
      if (retryAt !== null) {
        await this.ctx.storage.setAlarm(retryAt);
      }
      this.log("r2_flush_error", {
        runId: failed.runId,
        message: errorMessage(error),
        retryAt: failed.nextActionAt,
      });
      return { state: failed, success: false };
    }
  }

  private async flushSnapshot(state: RelayState): Promise<RelayState> {
    const snapshotState = await flushRelaySnapshot(
      this.env,
      state,
      listComments(this.ctx.storage, state.runId),
    );
    this.saveState(snapshotState);
    return snapshotState;
  }

  private cycleRuntime(): RelayCycleRuntime {
    return {
      env: this.env,
      storage: this.ctx.storage,
      requireCurrentRun: (runId) => this.requireCurrentRun(runId),
      saveState: (state) => this.saveState(state),
      flushSnapshot: (state, force) => this.safeFlushSnapshot(state, force),
      log: (event, details) => this.log(event, details),
    };
  }

  private currentStatus(): RelayStatus {
    return this.statusFor(this.loadState());
  }

  private statusFor(state: RelayState): RelayStatus {
    return toRelayStatus(
      state,
      countComments(this.ctx.storage, state.runId),
      readRelayConfig(this.env),
    );
  }

  private requireCurrentRun(runId: string): RelayState | null {
    const state = this.loadState();
    return state.enabled && state.runId === runId ? state : null;
  }

  private loadState(): RelayState {
    return loadRelayState(this.ctx.storage, (error) => {
      this.log("state_parse_error", { message: errorMessage(error) });
    });
  }

  private saveState(state: RelayState): void {
    saveRelayState(this.ctx.storage, state);
  }

  private runSerially<T>(operation: () => Promise<T> | T, drainAll = false): Promise<T> {
    const previous = this.operationTail;
    let release: (() => void) | undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await previous;
      try {
        // Complete queued events before a control action can end or replace their session.
        this.drainTwitch(drainAll);
        return await operation();
      } finally {
        try {
          this.drainTwitch();
          await this.ctx.storage.transaction(async (transaction) => {
            const pending = this.ctx.storage.sql.exec("SELECT seq FROM twitch_pending LIMIT 1").toArray().length > 0;
            const target = pending ? Date.now() : nextRelayAlarm(this.loadState());
            if (target !== null) {
              if (await transaction.getAlarm() !== target) await transaction.setAlarm(target);
            } else {
              await transaction.deleteAlarm();
            }
          });
        } finally {
          release?.();
        }
      }
    })();
  }

  private log(event: string, details: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        level: "info",
        event,
        timestamp: new Date().toISOString(),
        ...details,
      }),
    );
  }
}

function isExportedComment(value: unknown): value is {
  name: string;
  message: string;
  created_at: string;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const comment = value as Record<string, unknown>;
  return (
    typeof comment.name === "string" &&
    typeof comment.message === "string" &&
    typeof comment.created_at === "string"
  );
}

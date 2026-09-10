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
  archiveObjectKey,
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
    return this.runSerially(() => this.startInternal(channelRef), { drainAll: true });
  }

  async startE2E(channelRef: string, videoId: string): Promise<RelayStatus> {
    return this.runSerially(() => this.startE2EInternal(channelRef, videoId), { drainAll: true });
  }

  async stop(reason = "manual"): Promise<RelayStatus> {
    return this.runSerially(() => this.stopInternal(reason), { drainAll: true });
  }

  async status(): Promise<RelayStatus> {
    return this.runSerially(() => this.currentStatus(), { readOnly: true });
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
      // Don't clear lastError here: it would erase the only diagnostic (e.g. a
      // revocation reason) the moment an operator clicks "start" to recover, even
      // though nothing has actually been confirmed fixed yet. It's cleared once a
      // fresh webhook_callback_verification actually confirms the subscriptions work.
      state = { ...state, archiveChannel: config.channel, twitch: { ...state.twitch, enabled: true,
        channel: config.channel, broadcasterId: config.broadcasterId, subscriptions,
        phase: TWITCH_EVENT_TYPES.every((type) => subscriptions[type]) ? "running" : "waiting",
        startedAt: state.twitch.enabled && sameChannel ? state.twitch.startedAt : new Date().toISOString(),
        lastReceivedAt: state.twitch.enabled && sameChannel ? state.twitch.lastReceivedAt : null,
      } };
      this.saveState(state);
      return this.statusFor((await this.safeFlushSnapshot(state, true)).state);
    }, { drainAll: true });
  }

  async stopTwitch(): Promise<RelayStatus> {
    return this.runSerially(async () => {
      const state = this.loadState();
      const stopped: RelayState = { ...state, twitch: { ...state.twitch, enabled: false, phase: "stopped" } };
      this.saveState(stopped);
      return this.statusFor((await this.safeFlushSnapshot(stopped, true)).state);
    }, { drainAll: true });
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

  /** Returns whether any pending delivery was applied (i.e. relay_state changed). */
  private drainTwitch(all = false): boolean {
    return this.ctx.storage.transactionSync(() => {
      const pending = this.ctx.storage.sql.exec<{ seq: number; delivery: string }>(
        "SELECT seq, delivery FROM twitch_pending ORDER BY seq LIMIT ?", all ? -1 : 200,
      ).toArray();
      if (pending.length === 0) return false;

      // Load/save once per batch, not per row: nothing else can observe or mutate
      // relay_state between iterations (single-threaded, no awaits in this function),
      // so accumulating onto one in-memory copy is equivalent to the original
      // reload-after-every-save, minus up to 199 redundant round trips per drain.
      const state = this.loadState();
      const twitch = { ...state.twitch, subscriptions: { ...state.twitch.subscriptions } };
      let dirty = false;
      for (const row of pending) {
        // Delete before processing, and keep failures scoped to this row: drainTwitch
        // runs at the start of every runSerially() call (status, deltas, start/stop,
        // alarm), so one throwing delivery must not roll back this whole batch's
        // deletes and permanently wedge every future call on the same poison pill.
        this.ctx.storage.sql.exec("DELETE FROM twitch_pending WHERE seq = ?", row.seq);
        try {
          if (this.applyPendingTwitchDelivery(state, twitch, JSON.parse(row.delivery) as TwitchDelivery)) {
            dirty = true;
          }
        } catch (error) {
          // Surface this beyond the log: otherwise the admin UI keeps showing "running"
          // while a delivery is silently and permanently discarded.
          twitch.lastError = `Twitch: 通知の処理に失敗しました (${errorMessage(error)})`;
          dirty = true;
          this.log("twitch_delivery_dropped", { seq: row.seq, message: errorMessage(error) });
        }
      }
      if (!dirty) return false;
      // Registering webhooks before the first session must not replace the pre-live R2 snapshot.
      if (state.startedAt !== null) {
        twitch.flushAt ??= new Date(Math.max(Date.now(),
          (Date.parse(state.lastFlushAt ?? "") || 0) + readRelayConfig(this.env).r2FlushIntervalMs)).toISOString();
      }
      this.saveState({ ...state, twitch, updatedAt: new Date().toISOString() });
      return true;
    });
  }

  /** Mutates `twitch` in place; returns whether it applied a change worth persisting. */
  private applyPendingTwitchDelivery(
    state: RelayState,
    twitch: RelayState["twitch"],
    delivery: TwitchDelivery,
  ): boolean {
    if (delivery.kind === "webhook_callback_verification") {
      if (twitch.broadcasterId !== delivery.broadcasterId) twitch.subscriptions = {};
      twitch.broadcasterId = delivery.broadcasterId;
      twitch.channel = twitchConfig(this.env).channel;
      twitch.subscriptions[delivery.type] = delivery.subscriptionId;
      if (twitch.enabled && TWITCH_EVENT_TYPES.every((type) => twitch.subscriptions[type])) {
        twitch.phase = "running";
        twitch.lastError = null;
      }
      return true;
    }
    if (twitch.broadcasterId !== delivery.broadcasterId) {
      // broadcasterId is the authorization-relevant check here, and readTwitchDelivery
      // already verified it (HMAC + subscription condition) against the currently
      // configured broadcaster before this delivery was ever enqueued. Deliberately NOT
      // also requiring subscriptions[type] === delivery.subscriptionId: that map is only
      // ever populated by webhook_callback_verification, so losing it (e.g. a
      // loadRelayState parse-error fallback) would otherwise silently and permanently
      // drop every future, correctly-authenticated notification with no way to recover
      // short of deleting and recreating the Twitch subscriptions.
      this.log("twitch_notification_unmatched", {
        kind: delivery.kind,
        type: delivery.type,
        subscriptionId: delivery.subscriptionId,
      });
      return false;
    }
    if (delivery.kind === "revocation") {
      delete twitch.subscriptions[delivery.type];
      twitch.phase = twitch.enabled ? "error" : "stopped";
      twitch.lastError = `Twitch: ${delivery.type} (${delivery.reason})。購読を再設定してください。`;
      return true;
    }
    if (!twitch.enabled || Date.parse(delivery.timestamp) < Date.parse(twitch.startedAt ?? "")) return false;
    applyTwitchDelivery(this.ctx.storage, state.runId, delivery);
    twitch.lastReceivedAt = new Date().toISOString();
    return true;
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
    }, { readOnly: true });
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
    }, { readOnly: true });
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

    // Continue the same run only if Twitch is actively sharing it AND it hasn't
    // already carried a finished YouTube broadcast (current.videoId === null): once a
    // broadcast has used this run, a later start() is for a *new* broadcast, even if
    // Twitch never stopped in between. Otherwise every later stream would append to
    // the same runId/archive forever as long as Twitch stayed on (the documented,
    // ordinary way to run this relay), merging unrelated broadcasts' comments.
    const continuesRun = current.twitch.enabled && current.videoId === null;
    if (!continuesRun) await this.archiveAndClearRun(current);

    let next = createRunningState(channelRef, now);
    next.twitch = current.twitch;
    if (continuesRun) {
      next.runId = current.runId;
      next.startedAt = current.startedAt;
      next.archiveChannel = current.archiveChannel;
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

    // See startInternal's continuesRun comment: only merge into the existing run if
    // it hasn't already carried a finished broadcast.
    const continuesRun = current.twitch.enabled && current.videoId === null;
    if (!continuesRun) await this.archiveAndClearRun(current);

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
    if (continuesRun) {
      next.runId = current.runId;
      next.startedAt = current.startedAt;
      next.archiveChannel = current.archiveChannel;
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
      oldArchived = flush.success && archiveObjectKey(flush.state) !== null;
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

  private runSerially<T>(
    operation: () => Promise<T> | T,
    options: { drainAll?: boolean; readOnly?: boolean } = {},
  ): Promise<T> {
    const { drainAll = false, readOnly = false } = options;
    const previous = this.operationTail;
    let release: (() => void) | undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await previous;
      let drained = false;
      try {
        // Complete queued events before a control action can end or replace their session.
        drained = this.drainTwitch(drainAll);
        return await operation();
      } finally {
        try {
          // Read-only callers (status, delta) never mutate anything the alarm target
          // depends on, and receiveTwitch() already arms its own alarm independently of
          // this reconciliation — so on a truly idle poll (nothing was pending above),
          // skip re-draining and rewriting the alarm. This avoids an unconditional
          // deleteAlarm() write on every call to the unauthenticated delta endpoints
          // while idle. If something *was* drained above (e.g. a message that just set
          // twitch.flushAt), still reconcile so the alarm reflects it rather than the
          // immediate value receiveTwitch armed it to before the drain.
          if (!readOnly || drained) {
            this.drainTwitch();
            await this.ctx.storage.transaction(async (transaction) => {
              const pending = this.ctx.storage.sql.exec("SELECT seq FROM twitch_pending LIMIT 1").toArray().length > 0;
              const target = pending ? Date.now() : nextRelayAlarm(this.loadState());
              if (target !== null) {
                if (await transaction.getAlarm() !== target) await transaction.setAlarm(target);
              } else {
                // Safe only because nothing awaits between the SELECT above and this
                // deleteAlarm(): a concurrent receiveTwitch() insert can only land fully
                // before this synchronous block runs (pending would be true) or fully
                // after (its own getAlarm()/setAlarm() then re-arms from null). Adding
                // an await in this branch before deleteAlarm() would break that.
                await transaction.deleteAlarm();
              }
            });
          }
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

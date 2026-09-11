import { DurableObject } from "cloudflare:workers";
import {
  discoverBroadcast,
  pollLiveChat,
  type RelayCycleRuntime,
} from "./relay-cycle";
import { errorMessage, isFatalYouTubeError } from "./relay-errors";
import { flushRelaySnapshot } from "./relay-r2";
import { nextRelayAlarm } from "./relay-schedule";
import {
  TWITCH_EVENT_TYPES,
  createGuestNick,
  parseTwitchIrcFrame,
  twitchConfig,
  twitchIrcHandshake,
  type TwitchDelivery,
} from "./twitch";
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
  private twitchSocket: WebSocket | null = null;
  private twitchSocketGeneration = 0;
  private twitchReconnectAttempt = 0;
  private twitchNick: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      initializeRelayStorage(this.ctx.storage);
      // Outbound WebSockets cannot use Durable Object WebSocket hibernation. Keep an
      // alarm armed while Twitch is enabled so a recreated/evicted object reconnects
      // even when no HTTP request happens to wake it first.
      if (this.loadState().twitch.enabled) {
        await this.ctx.storage.setAlarm(Date.now());
      }
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
        state = {
          ...createRunningState(""),
          enabled: false,
          phase: "stopped",
          channelRef: null,
          nextActionAt: null,
          twitch: state.twitch,
        };
      }

      const sameChannel = state.twitch.channel === config.channel;
      this.closeTwitchSocket();
      state = {
        ...state,
        archiveChannel: config.channel,
        twitch: {
          ...state.twitch,
          enabled: true,
          channel: config.channel,
          // relay-storage historically uses broadcasterId as the Twitch source
          // namespace. IRC has no broadcaster-id lookup, so use the normalized login.
          broadcasterId: config.channel,
          subscriptions: {},
          phase: "waiting",
          startedAt:
            state.twitch.enabled && sameChannel
              ? state.twitch.startedAt
              : new Date().toISOString(),
          lastError: null,
          lastReceivedAt:
            state.twitch.enabled && sameChannel
              ? state.twitch.lastReceivedAt
              : null,
        },
      };
      this.saveState(state);
      this.ensureTwitchConnection();
      return this.statusFor((await this.safeFlushSnapshot(state, true)).state);
    }, { drainAll: true });
  }

  async stopTwitch(): Promise<RelayStatus> {
    return this.runSerially(async () => {
      this.closeTwitchSocket();
      const state = this.loadState();
      const stopped: RelayState = {
        ...state,
        twitch: {
          ...state.twitch,
          enabled: false,
          phase: "stopped",
          subscriptions: {},
          lastError: null,
        },
      };
      this.saveState(stopped);
      return this.statusFor((await this.safeFlushSnapshot(stopped, true)).state);
    }, { drainAll: true });
  }

  /** Durable queue boundary shared by the IRC socket and unit/runtime tests. */
  async receiveTwitch(delivery: TwitchDelivery): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      if (!acceptTwitchDelivery(this.ctx.storage, delivery.id)) return;
      this.ctx.storage.sql.exec(
        "INSERT INTO twitch_pending (delivery) VALUES (?)",
        JSON.stringify(delivery),
      );
      const alarm = await transaction.getAlarm();
      if (alarm === null || alarm > Date.now()) {
        await transaction.setAlarm(Date.now());
      }
    });
  }

  /** Returns whether any pending delivery was applied (i.e. relay_state changed). */
  private drainTwitch(all = false): boolean {
    return this.ctx.storage.transactionSync(() => {
      const pending = this.ctx.storage.sql.exec<{ seq: number; delivery: string }>(
        "SELECT seq, delivery FROM twitch_pending ORDER BY seq LIMIT ?",
        all ? -1 : 200,
      ).toArray();
      if (pending.length === 0) return false;

      const state = this.loadState();
      const twitch = {
        ...state.twitch,
        subscriptions: { ...state.twitch.subscriptions },
      };
      let dirty = false;
      for (const row of pending) {
        this.ctx.storage.sql.exec(
          "DELETE FROM twitch_pending WHERE seq = ?",
          row.seq,
        );
        try {
          if (
            this.applyPendingTwitchDelivery(
              state,
              twitch,
              JSON.parse(row.delivery) as TwitchDelivery,
            )
          ) {
            dirty = true;
          }
        } catch (error) {
          twitch.lastError = `Twitch: イベントの処理に失敗しました (${errorMessage(error)})`;
          dirty = true;
          this.log("twitch_delivery_dropped", {
            seq: row.seq,
            message: errorMessage(error),
          });
        }
      }
      if (!dirty) return false;
      if (state.startedAt !== null) {
        twitch.flushAt ??= new Date(
          Math.max(
            Date.now(),
            (Date.parse(state.lastFlushAt ?? "") || 0) +
              readRelayConfig(this.env).r2FlushIntervalMs,
          ),
        ).toISOString();
      }
      this.saveState({
        ...state,
        twitch,
        updatedAt: new Date().toISOString(),
      });
      return true;
    });
  }

  private applyPendingTwitchDelivery(
    state: RelayState,
    twitch: RelayState["twitch"],
    delivery: TwitchDelivery,
  ): boolean {
    if (
      !twitch.enabled ||
      twitch.broadcasterId !== delivery.broadcasterId ||
      Date.parse(delivery.timestamp) < Date.parse(twitch.startedAt ?? "")
    ) {
      return false;
    }
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
      const delta = getSimpleCommentDelta(
        this.ctx.storage,
        state.runId,
        limit,
      );
      if (state.enabled || state.twitch.enabled || delta.events.length > 0) {
        return delta;
      }

      const config = readRelayConfig(this.env);
      const object = await this.env.COMMENTS_BUCKET.get(config.currentObjectKey);
      if (object === null) return delta;

      try {
        const snapshot = await object.json<unknown>();
        if (!Array.isArray(snapshot)) return delta;
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
      if (state.twitch.enabled) {
        this.ensureTwitchConnection();
        state = this.loadState();
      }

      if (
        state.twitch.flushAt !== null &&
        Date.parse(state.twitch.flushAt) <= Date.now()
      ) {
        state = (await this.safeFlushSnapshot(state, true)).state;
      }
      if (!state.enabled) {
        if (
          state.lastError?.startsWith("R2:") === true &&
          Date.parse(state.nextActionAt ?? "") <= Date.now()
        ) {
          const flush = await this.safeFlushSnapshot(state, true);
          if (flush.success) await this.ctx.storage.deleteAlarm();
        }
        return;
      }

      // A Twitch flush/watchdog alarm may fire earlier than YouTube's polling interval.
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

  private ensureTwitchConnection(): void {
    const state = this.loadState();
    if (!state.twitch.enabled) {
      this.closeTwitchSocket();
      return;
    }
    if (
      this.twitchSocket !== null &&
      (this.twitchSocket.readyState === 0 || this.twitchSocket.readyState === 1)
    ) {
      return;
    }

    let config: ReturnType<typeof twitchConfig>;
    try {
      config = twitchConfig(this.env);
    } catch (error) {
      this.recordTwitchConnectFailure(errorMessage(error));
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(config.url);
    } catch (error) {
      this.recordTwitchConnectFailure(errorMessage(error));
      return;
    }

    const generation = ++this.twitchSocketGeneration;
    this.twitchSocket = socket;
    this.twitchNick = createGuestNick();
    this.saveState({
      ...state,
      twitch: {
        ...state.twitch,
        channel: config.channel,
        broadcasterId: config.channel,
        subscriptions: {},
        phase: "waiting",
        lastError: null,
      },
      updatedAt: new Date().toISOString(),
    });

    socket.addEventListener("open", () => {
      if (!this.ownsTwitchSocket(socket, generation)) return;
      try {
        for (const command of twitchIrcHandshake(config.channel, this.twitchNick!)) {
          socket.send(command);
        }
        this.log("twitch_irc_open", {
          channel: config.channel,
          nick: this.twitchNick,
        });
      } catch (error) {
        this.scheduleTwitchReconnect(
          socket,
          generation,
          `IRC handshake failed: ${errorMessage(error)}`,
        );
      }
    });

    socket.addEventListener("message", (event) => {
      if (!this.ownsTwitchSocket(socket, generation)) return;
      if (typeof event.data !== "string") {
        this.log("twitch_irc_non_text_frame", { type: typeof event.data });
        return;
      }
      try {
        for (const item of parseTwitchIrcFrame(event.data)) {
          if (item.kind === "ping") {
            socket.send(`PONG ${item.payload}`);
            this.markTwitchConnected(item.channel ?? null);
            continue;
          }
          if (item.kind === "reconnect") {
            this.scheduleTwitchReconnect(
              socket,
              generation,
              "Twitch requested reconnect",
              0,
            );
            return;
          }
          if (item.kind === "notice") {
            this.markTwitchConnected(item.channel);
            this.recordTwitchNotice(item.code, item.message);
            continue;
          }
          if (item.kind === "activity") {
            this.markTwitchConnected(item.channel);
            continue;
          }
          this.markTwitchConnected(item.delivery.broadcasterId);
          this.ctx.waitUntil(
            this.receiveTwitch(item.delivery).catch((error) => {
              this.log("twitch_irc_enqueue_error", {
                message: errorMessage(error),
              });
            }),
          );
        }
      } catch (error) {
        this.log("twitch_irc_parse_error", { message: errorMessage(error) });
      }
    });

    socket.addEventListener("error", () => {
      this.scheduleTwitchReconnect(socket, generation, "IRC socket error");
    });
    socket.addEventListener("close", () => {
      this.scheduleTwitchReconnect(socket, generation, "IRC socket closed");
    });
  }

  private markTwitchConnected(channel: string | null): void {
    const state = this.loadState();
    if (!state.twitch.enabled) return;
    if (channel !== null && channel !== state.twitch.channel) return;
    this.twitchReconnectAttempt = 0;
    if (state.twitch.phase === "running" && state.twitch.lastError === null) return;
    this.saveState({
      ...state,
      twitch: {
        ...state.twitch,
        phase: "running",
        lastError: null,
        subscriptions: Object.fromEntries(
          TWITCH_EVENT_TYPES.map((type) => [type, "irc"]),
        ) as RelayState["twitch"]["subscriptions"],
      },
      updatedAt: new Date().toISOString(),
    });
  }

  private recordTwitchNotice(code: string | null, message: string): void {
    if (message === "") return;
    const state = this.loadState();
    if (!state.twitch.enabled) return;
    this.saveState({
      ...state,
      twitch: {
        ...state.twitch,
        lastError: `Twitch IRC${code ? ` (${code})` : ""}: ${message}`,
      },
      updatedAt: new Date().toISOString(),
    });
    this.log("twitch_irc_notice", { code, message });
  }

  private recordTwitchConnectFailure(message: string): void {
    const state = this.loadState();
    if (!state.twitch.enabled) return;
    const delay = this.nextTwitchReconnectDelay();
    this.saveState({
      ...state,
      twitch: {
        ...state.twitch,
        phase: "error",
        subscriptions: {},
        lastError: `Twitch IRC: ${message}`,
      },
      updatedAt: new Date().toISOString(),
    });
    this.ctx.waitUntil(
      this.ctx.storage.setAlarm(Date.now() + delay).catch((error) => {
        this.log("twitch_reconnect_alarm_error", {
          message: errorMessage(error),
        });
      }),
    );
  }

  private scheduleTwitchReconnect(
    socket: WebSocket,
    generation: number,
    reason: string,
    overrideDelay?: number,
  ): void {
    if (!this.ownsTwitchSocket(socket, generation)) return;
    this.twitchSocket = null;
    this.twitchNick = null;
    ++this.twitchSocketGeneration;
    try {
      if (socket.readyState < 2) socket.close();
    } catch {
      // The connection is already being discarded; reconnect below is authoritative.
    }

    const state = this.loadState();
    if (!state.twitch.enabled) return;
    const delay = overrideDelay ?? this.nextTwitchReconnectDelay();
    this.saveState({
      ...state,
      twitch: {
        ...state.twitch,
        phase: "error",
        subscriptions: {},
        lastError: `Twitch IRC: ${reason}`,
      },
      updatedAt: new Date().toISOString(),
    });
    this.ctx.waitUntil(
      this.ctx.storage.setAlarm(Date.now() + delay).catch((error) => {
        this.log("twitch_reconnect_alarm_error", {
          message: errorMessage(error),
        });
      }),
    );
    this.log("twitch_irc_reconnect_scheduled", { reason, delay });
  }

  private nextTwitchReconnectDelay(): number {
    const attempt = ++this.twitchReconnectAttempt;
    return Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
  }

  private closeTwitchSocket(): void {
    const socket = this.twitchSocket;
    this.twitchSocket = null;
    this.twitchNick = null;
    ++this.twitchSocketGeneration;
    this.twitchReconnectAttempt = 0;
    if (socket !== null && socket.readyState < 2) {
      try {
        socket.close();
      } catch {
        // Ignore shutdown races; the socket is no longer considered owned.
      }
    }
  }

  private ownsTwitchSocket(socket: WebSocket, generation: number): boolean {
    return this.twitchSocket === socket && this.twitchSocketGeneration === generation;
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
      if (shouldRediscover) await this.ctx.storage.setAlarm(Date.now());
      current = (await this.safeFlushSnapshot(current, true)).state;
      this.log("relay_start_refreshed", {
        runId: current.runId,
        channelId: current.channelId,
        videoId: current.videoId,
        rediscoveryRequested: shouldRediscover,
      });
      return this.statusFor(current);
    }

    const continuesRun = current.twitch.enabled && current.videoId === null;
    if (!continuesRun) await this.archiveAndClearRun(current);

    let next = createRunningState(channelRef, now);
    next.twitch = current.twitch;
    if (continuesRun) {
      next.runId = current.runId;
      next.startedAt = current.startedAt;
    }
    next.archiveChannel = current.twitch.enabled ? current.twitch.channel : null;
    this.saveState(next);
    await this.ctx.storage.setAlarm(Date.now());
    next = (await this.safeFlushSnapshot(next, true)).state;

    this.log("relay_started", { runId: next.runId, channelRef });
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
    }
    next.archiveChannel = current.twitch.enabled ? current.twitch.channel : null;
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
    if (state === null) return;

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
    this.log("relay_fatal_error", { runId: failed.runId, message });
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
        twitch: {
          ...fresh.twitch,
          flushAt:
            fresh.twitch.flushAt === null
              ? null
              : new Date(Date.now() + 30_000).toISOString(),
        },
        lastError: `R2: ${errorMessage(error)}`,
        updatedAt: new Date().toISOString(),
        nextActionAt:
          retryAt === null
            ? fresh.nextActionAt
            : new Date(retryAt).toISOString(),
      };
      this.saveState(failed);
      if (retryAt !== null) await this.ctx.storage.setAlarm(retryAt);
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
        drained = this.drainTwitch(drainAll);
        return await operation();
      } finally {
        try {
          if (!readOnly || drained) {
            try {
              this.drainTwitch();
              await this.ctx.storage.transaction(async (transaction) => {
                const pending =
                  this.ctx.storage.sql
                    .exec("SELECT seq FROM twitch_pending LIMIT 1")
                    .toArray().length > 0;
                const target = pending
                  ? Date.now()
                  : nextRelayAlarm(this.loadState());
                if (target !== null) {
                  if ((await transaction.getAlarm()) !== target) {
                    await transaction.setAlarm(target);
                  }
                } else {
                  await transaction.deleteAlarm();
                }
              });
            } catch (error) {
              this.log("alarm_reconcile_error", {
                message: errorMessage(error),
              });
            }
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
  if (typeof value !== "object" || value === null) return false;
  const comment = value as Record<string, unknown>;
  return (
    typeof comment.name === "string" &&
    typeof comment.message === "string" &&
    typeof comment.created_at === "string"
  );
}

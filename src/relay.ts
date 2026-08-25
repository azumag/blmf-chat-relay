import { DurableObject } from "cloudflare:workers";
import { discoverBroadcast, pollLiveChat, type RelayCycleRuntime } from "./relay-cycle";
import { errorMessage, isFatalYouTubeError } from "./relay-errors";
import { flushRelaySnapshot } from "./relay-r2";
import {
  countComments,
  deleteRunComments,
  initializeRelayStorage,
  listComments,
  loadRelayState,
  saveRelayState,
} from "./relay-storage";
import {
  createRunningState,
  readRelayConfig,
  toRelayStatus,
  type RelayState,
  type RelayStatus,
} from "./types";
import {
  parseChannelReference,
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
    return this.runSerially(() => this.startInternal(channelRef));
  }

  async stop(reason = "manual"): Promise<RelayStatus> {
    return this.runSerially(() => this.stopInternal(reason));
  }

  async status(): Promise<RelayStatus> {
    return this.runSerially(() => this.currentStatus());
  }

  override async alarm(): Promise<void> {
    await this.runSerially(async () => {
      const state = this.loadState();
      if (!state.enabled) {
        if (state.lastError?.startsWith("R2:") === true) {
          const flush = await this.safeFlushSnapshot(state, true);
          if (flush.success) {
            await this.ctx.storage.deleteAlarm();
          }
        }
        return;
      }

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

    const oldRunId = current.runId;
    const oldCommentCount = countComments(this.ctx.storage, oldRunId);
    let oldArchived = oldCommentCount === 0;
    if (oldCommentCount > 0) {
      const flush = await this.safeFlushSnapshot(current, true);
      current = flush.state;
      oldArchived = flush.success && current.videoId !== null;
    }

    if (oldArchived) {
      deleteRunComments(this.ctx.storage, oldRunId);
    }

    let next = createRunningState(channelRef, now);
    this.saveState(next);
    await this.ctx.storage.setAlarm(Date.now());
    next = (await this.safeFlushSnapshot(next, true)).state;

    this.log("relay_started", {
      runId: next.runId,
      channelRef,
    });
    return this.statusFor(next);
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

  private runSerially<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.operationTail;
    let release: (() => void) | undefined;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    return (async () => {
      await previous;
      try {
        return await operation();
      } finally {
        release?.();
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

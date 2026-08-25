import { countComments, applyChatItems } from "./relay-storage";
import {
  readRelayConfig,
  type RelayState,
} from "./types";
import {
  findActiveBroadcast,
  listLiveChatMessages,
  resolveChannel,
} from "./youtube";

export interface RelayCycleRuntime {
  env: Env;
  storage: DurableObjectStorage;
  requireCurrentRun: (runId: string) => RelayState | null;
  saveState: (state: RelayState) => void;
  flushSnapshot: (
    state: RelayState,
    force: boolean,
  ) => Promise<{ state: RelayState; success: boolean }>;
  log: (event: string, details: Record<string, unknown>) => void;
}

export async function discoverBroadcast(
  runtime: RelayCycleRuntime,
  initialState: RelayState,
): Promise<void> {
  let state = runtime.requireCurrentRun(initialState.runId);
  if (state === null || state.channelRef === null) {
    return;
  }
  const channelRef = state.channelRef;

  const discoveringAt = new Date().toISOString();
  state = {
    ...state,
    phase: "discovering",
    updatedAt: discoveringAt,
    nextActionAt: discoveringAt,
  };
  runtime.saveState(state);

  if (state.channelId === null) {
    const resolved = await resolveChannel(
      runtime.env.YOUTUBE_API_KEY,
      channelRef,
    );
    const fresh = runtime.requireCurrentRun(initialState.runId);
    if (fresh === null) {
      return;
    }
    state = {
      ...fresh,
      channelId: resolved.id,
      channelTitle: resolved.title,
      updatedAt: new Date().toISOString(),
    };
    runtime.saveState(state);
  }

  if (state.channelId === null) {
    throw new Error("YouTube チャンネル ID を解決できませんでした。");
  }

  const broadcast = await findActiveBroadcast(
    runtime.env.YOUTUBE_API_KEY,
    state.channelId,
  );
  const fresh = runtime.requireCurrentRun(initialState.runId);
  if (fresh === null) {
    return;
  }

  if (broadcast === null) {
    const target = Date.now() + readRelayConfig(runtime.env).discoveryIntervalMs;
    state = {
      ...fresh,
      phase: "waiting",
      videoId: null,
      videoTitle: null,
      liveChatId: null,
      nextPageToken: null,
      liveStartedAt: null,
      lastError: null,
      consecutiveErrors: 0,
      updatedAt: new Date().toISOString(),
      nextActionAt: new Date(target).toISOString(),
    };
    runtime.saveState(state);
    await runtime.storage.setAlarm(target);
    await runtime.flushSnapshot(state, true);
    runtime.log("broadcast_not_found", {
      runId: state.runId,
      channelId: state.channelId,
      nextActionAt: state.nextActionAt,
    });
    return;
  }

  state = {
    ...fresh,
    phase: "running",
    videoId: broadcast.videoId,
    videoTitle: broadcast.title,
    liveChatId: broadcast.liveChatId,
    nextPageToken: null,
    liveStartedAt: broadcast.actualStartTime,
    lastError: null,
    consecutiveErrors: 0,
    updatedAt: new Date().toISOString(),
    nextActionAt: new Date().toISOString(),
  };
  runtime.saveState(state);
  state = (await runtime.flushSnapshot(state, true)).state;

  runtime.log("broadcast_discovered", {
    runId: state.runId,
    channelId: state.channelId,
    videoId: state.videoId,
  });
  await pollLiveChat(runtime, state);
}

export async function pollLiveChat(
  runtime: RelayCycleRuntime,
  initialState: RelayState,
): Promise<void> {
  if (initialState.liveChatId === null) {
    throw new Error("ライブチャット ID がありません。");
  }

  const page = await listLiveChatMessages(
    runtime.env.YOUTUBE_API_KEY,
    initialState.liveChatId,
    initialState.nextPageToken,
  );
  let state = runtime.requireCurrentRun(initialState.runId);
  if (state === null) {
    return;
  }

  const mutation = applyChatItems(runtime.storage, state.runId, page.items);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  state = {
    ...state,
    phase: "running",
    nextPageToken: page.nextPageToken,
    lastPollAt: now,
    lastError: null,
    consecutiveErrors: 0,
    updatedAt: now,
  };

  if (mutation.ended || page.offlineAt !== null) {
    state = {
      ...state,
      enabled: false,
      phase: "stopped",
      stoppedAt: page.offlineAt ?? now,
      stopReason: "youtube-ended",
      nextActionAt: null,
    };
    runtime.saveState(state);
    await runtime.storage.deleteAlarm();
    await runtime.flushSnapshot(state, true);
    runtime.log("broadcast_ended", {
      runId: state.runId,
      videoId: state.videoId,
      commentCount: countComments(runtime.storage, state.runId),
    });
    return;
  }

  const nextAlarmAt = nowMs + page.pollingIntervalMillis;
  state = {
    ...state,
    nextActionAt: new Date(nextAlarmAt).toISOString(),
  };
  runtime.saveState(state);
  await runtime.storage.setAlarm(nextAlarmAt);

  const config = readRelayConfig(runtime.env);
  const lastFlushAt = Date.parse(state.lastFlushAt ?? "");
  const flushDue =
    state.lastFlushAt === null ||
    Number.isNaN(lastFlushAt) ||
    nowMs - lastFlushAt >= config.r2FlushIntervalMs;
  if (flushDue) {
    await runtime.flushSnapshot(state, false);
  }

  if (mutation.changed) {
    runtime.log("chat_batch_processed", {
      runId: state.runId,
      videoId: state.videoId,
      commentCount: countComments(runtime.storage, state.runId),
      nextActionAt: state.nextActionAt,
    });
  }
}

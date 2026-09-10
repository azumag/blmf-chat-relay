import { createTwitchState, TWITCH_EVENT_TYPES, type TwitchState } from "./twitch";

export type RelayPhase =
  | "stopped"
  | "discovering"
  | "waiting"
  | "running"
  | "error";

export interface RelayState {
  twitch: TwitchState;
  version: 1;
  enabled: boolean;
  runId: string;
  phase: RelayPhase;
  channelRef: string | null;
  channelId: string | null;
  channelTitle: string | null;
  videoId: string | null;
  videoTitle: string | null;
  // Twitch channel this run archives under (mirrors videoId's lifecycle): set
  // when Twitch starts contributing to this run, left untouched by stopTwitch
  // so the final flush still archives correctly, and reset to null only when
  // a genuinely new, unrelated run is created. Deliberately NOT read from the
  // long-lived twitch.channel field, which stopTwitch never clears and which
  // otherwise leaks into an unrelated later run's archive path.
  archiveChannel: string | null;
  liveChatId: string | null;
  nextPageToken: string | null;
  startedAt: string | null;
  liveStartedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  lastPollAt: string | null;
  lastFlushAt: string | null;
  updatedAt: string;
  nextActionAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
}

export interface ExportedComment {
  name: string;
  message: string;
  created_at: string;
}

export interface StoredComment extends ExportedComment {
  id: string;
  authorChannelId: string | null;
}

export type CommentDeltaEventType = "upsert" | "delete";

export interface CommentDeltaEvent {
  seq: number;
  type: CommentDeltaEventType;
  id: string;
  name: string | null;
  message: string | null;
  created_at: string;
}

export interface CommentDeltaResponse {
  streamId: string;
  events: CommentDeltaEvent[];
  nextCursor: number;
  hasMore: boolean;
  reset: boolean;
}

export interface SimpleCommentDeltaResponse {
  streamId: string;
  events: CommentDeltaEvent[];
  windowStartCursor: number;
  latestCursor: number;
  truncated: boolean;
  windowSize: number;
}

export interface RelayStatus {
  twitch: Omit<TwitchState, "flushAt" | "subscriptions"> & { ready: boolean };
  enabled: boolean;
  phase: RelayPhase;
  channel: {
    configured: string | null;
    id: string | null;
    title: string | null;
  };
  broadcast: {
    videoId: string | null;
    title: string | null;
    liveStartedAt: string | null;
  };
  commentCount: number;
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: string | null;
  lastPollAt: string | null;
  lastFlushAt: string | null;
  updatedAt: string;
  nextActionAt: string | null;
  lastError: string | null;
  urls: {
    comments: string;
    status: string;
    archive: string | null;
  };
}

export interface ResolvedChannel {
  id: string;
  title: string;
}

export interface ActiveBroadcast {
  videoId: string;
  title: string;
  liveChatId: string;
  actualStartTime: string | null;
}

export interface RelayConfig {
  discoveryIntervalMs: number;
  r2FlushIntervalMs: number;
  currentObjectKey: string;
  statusObjectKey: string;
  publicR2BaseUrl: string;
}

export function createStoppedState(now = new Date().toISOString()): RelayState {
  return {
    twitch: createTwitchState(),
    version: 1,
    enabled: false,
    runId: crypto.randomUUID(),
    phase: "stopped",
    channelRef: null,
    channelId: null,
    channelTitle: null,
    videoId: null,
    videoTitle: null,
    archiveChannel: null,
    liveChatId: null,
    nextPageToken: null,
    startedAt: null,
    liveStartedAt: null,
    stoppedAt: null,
    stopReason: null,
    lastPollAt: null,
    lastFlushAt: null,
    updatedAt: now,
    nextActionAt: null,
    lastError: null,
    consecutiveErrors: 0,
  };
}

export function createRunningState(
  channelRef: string,
  now = new Date().toISOString(),
): RelayState {
  return {
    ...createStoppedState(now),
    enabled: true,
    phase: "discovering",
    channelRef,
    startedAt: now,
    stoppedAt: null,
    stopReason: null,
    nextActionAt: now,
  };
}

export function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
  options: { min: number; max: number },
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(options.max, Math.max(options.min, parsed));
}

export function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

export function normalizeObjectKey(value: string, fallback: string): string {
  const normalized = trimSlashes(value.trim());
  return normalized === "" ? fallback : normalized;
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function buildPublicUrl(baseUrl: string, objectKey: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${normalizeObjectKey(objectKey, objectKey)}`;
}

export function archiveObjectKey(state: RelayState): string | null {
  if (state.videoId === null) {
    return state.archiveChannel === null ? null :
      `streams/twitch-${encodeURIComponent(state.archiveChannel)}/${encodeURIComponent(state.runId)}/comments.json`;
  }

  return `streams/${encodeURIComponent(state.videoId)}/comments.json`;
}

export function readRelayConfig(env: Env): RelayConfig {
  return {
    discoveryIntervalMs:
      parsePositiveInteger(env.DISCOVERY_INTERVAL_SECONDS, 300, {
        min: 30,
        max: 3600,
      }) * 1000,
    r2FlushIntervalMs:
      parsePositiveInteger(env.R2_FLUSH_INTERVAL_SECONDS, 15, {
        min: 5,
        max: 300,
      }) * 1000,
    currentObjectKey: normalizeObjectKey(
      env.R2_CURRENT_OBJECT_KEY,
      "comments.json",
    ),
    statusObjectKey: normalizeObjectKey(
      env.R2_STATUS_OBJECT_KEY,
      "status.json",
    ),
    publicR2BaseUrl: normalizeBaseUrl(env.PUBLIC_R2_BASE_URL),
  };
}

export function toRelayStatus(
  state: RelayState,
  commentCount: number,
  config: RelayConfig,
): RelayStatus {
  const archiveKey = archiveObjectKey(state);

  return {
    twitch: {
      enabled: state.twitch.enabled,
      channel: state.twitch.channel,
      broadcasterId: state.twitch.broadcasterId,
      phase: state.twitch.phase,
      startedAt: state.twitch.startedAt,
      lastReceivedAt: state.twitch.lastReceivedAt,
      lastError: state.twitch.lastError,
      ready: TWITCH_EVENT_TYPES.every((type) => state.twitch.subscriptions[type] !== undefined),
    },
    enabled: state.enabled,
    phase: state.phase,
    channel: {
      configured: state.channelRef,
      id: state.channelId,
      title: state.channelTitle,
    },
    broadcast: {
      videoId: state.videoId,
      title: state.videoTitle,
      liveStartedAt: state.liveStartedAt,
    },
    commentCount,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    stopReason: state.stopReason,
    lastPollAt: state.lastPollAt,
    lastFlushAt: state.lastFlushAt,
    updatedAt: state.updatedAt,
    nextActionAt: state.nextActionAt,
    lastError: state.lastError,
    urls: {
      comments: buildPublicUrl(
        config.publicR2BaseUrl,
        config.currentObjectKey,
      ),
      status: buildPublicUrl(config.publicR2BaseUrl, config.statusObjectKey),
      archive:
        archiveKey === null
          ? null
          : buildPublicUrl(config.publicR2BaseUrl, archiveKey),
    },
  };
}

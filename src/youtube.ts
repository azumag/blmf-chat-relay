import type {
  ActiveBroadcast,
  ResolvedChannel,
  StoredComment,
} from "./types";

const YOUTUBE_API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const CHANNEL_ID_PATTERN = /^UC[0-9A-Za-z_-]{22}$/;
const VIDEO_ID_PATTERN = /^[0-9A-Za-z_-]{11}$/;

export type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ParsedChannelReference =
  | { kind: "id"; value: string }
  | { kind: "handle"; value: string }
  | { kind: "username"; value: string };

interface YouTubeErrorResponse {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{
      message?: string;
      reason?: string;
      domain?: string;
    }>;
  };
}

interface ChannelListResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
    };
  }>;
}

interface SearchListResponse {
  items?: Array<{
    id?: {
      videoId?: string;
    };
    snippet?: {
      title?: string;
    };
  }>;
}

interface VideoListResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      title?: string;
      channelId?: string;
    };
    liveStreamingDetails?: {
      actualStartTime?: string;
      actualEndTime?: string;
      activeLiveChatId?: string;
    };
  }>;
}

export interface LiveChatMessageItem {
  id?: string;
  snippet?: {
    type?: string;
    publishedAt?: string;
    authorChannelId?: string;
    hasDisplayContent?: boolean;
    displayMessage?: string;
    userBannedDetails?: {
      bannedUserDetails?: {
        channelId?: string;
      };
    };
    messageDeletedDetails?: {
      deletedMessageId?: string;
    };
  };
  authorDetails?: {
    channelId?: string;
    displayName?: string;
  };
}

interface LiveChatMessageListResponse {
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  items?: LiveChatMessageItem[];
}

export interface LiveChatPage {
  items: LiveChatMessageItem[];
  nextPageToken: string | null;
  pollingIntervalMillis: number;
  offlineAt: string | null;
}

export type LiveChatMutation =
  | { kind: "upsert"; comment: StoredComment }
  | { kind: "delete-message"; messageId: string }
  | { kind: "delete-author"; authorChannelId: string }
  | { kind: "ended" }
  | { kind: "ignore" };

export class YouTubeApiError extends Error {
  readonly status: number;
  readonly reasons: readonly string[];

  constructor(message: string, status: number, reasons: readonly string[]) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reasons = reasons;
  }

  hasReason(...candidates: string[]): boolean {
    return candidates.some((candidate) => this.reasons.includes(candidate));
  }
}

export function parseChannelReference(input: string): ParsedChannelReference {
  const value = input.trim();
  if (value === "") {
    throw new Error("YouTube チャンネルを指定してください。");
  }
  if (value.length > 512) {
    throw new Error("YouTube チャンネル指定が長すぎます。");
  }

  if (CHANNEL_ID_PATTERN.test(value)) {
    return { kind: "id", value };
  }

  if (value.startsWith("@")) {
    return parseHandle(value);
  }

  if (/^https?:\/\//i.test(value)) {
    return parseYouTubeChannelUrl(value);
  }

  return parseHandle(`@${value}`);
}

function parseHandle(value: string): ParsedChannelReference {
  const handle = value.replace(/^@/, "").trim();
  if (handle === "" || /[/?#]/.test(handle)) {
    throw new Error("YouTube ハンドルの形式が正しくありません。");
  }
  return { kind: "handle", value: handle };
}

function parseYouTubeChannelUrl(value: string): ParsedChannelReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("YouTube チャンネル URL の形式が正しくありません。");
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "youtube.com" && hostname !== "m.youtube.com") {
    throw new Error("youtube.com のチャンネル URL を指定してください。");
  }

  const segments = url.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment));

  const [first, second] = segments;
  if (first === undefined) {
    throw new Error("YouTube チャンネル URL にチャンネル情報がありません。");
  }

  if (first === "channel" && second !== undefined) {
    if (!CHANNEL_ID_PATTERN.test(second)) {
      throw new Error("YouTube チャンネル ID の形式が正しくありません。");
    }
    return { kind: "id", value: second };
  }

  if (first === "user" && second !== undefined) {
    return { kind: "username", value: second };
  }

  if (first.startsWith("@")) {
    return parseHandle(first);
  }

  throw new Error(
    "対応している形式は UC で始まるチャンネル ID、@handle、/channel/ または /@handle の URL です。",
  );
}

export async function resolveChannel(
  apiKey: string,
  input: string,
  fetcher: Fetcher = fetch,
): Promise<ResolvedChannel> {
  const parsed = parseChannelReference(input);
  const params = new URLSearchParams({
    part: "id,snippet",
    key: apiKey,
  });

  switch (parsed.kind) {
    case "id":
      params.set("id", parsed.value);
      break;
    case "handle":
      params.set("forHandle", parsed.value);
      break;
    case "username":
      params.set("forUsername", parsed.value);
      break;
  }

  const response = await youtubeRequest<ChannelListResponse>(
    "/channels",
    params,
    fetcher,
  );
  const channel = response.items?.[0];
  if (channel?.id === undefined) {
    throw new YouTubeApiError(
      "指定された YouTube チャンネルが見つかりませんでした。",
      404,
      ["channelNotFound"],
    );
  }

  return {
    id: channel.id,
    title: channel.snippet?.title ?? channel.id,
  };
}

export async function findActiveBroadcast(
  apiKey: string,
  channelId: string,
  fetcher: Fetcher = fetch,
): Promise<ActiveBroadcast | null> {
  const search = await youtubeRequest<SearchListResponse>(
    "/search",
    new URLSearchParams({
      part: "snippet",
      channelId,
      eventType: "live",
      type: "video",
      order: "date",
      maxResults: "5",
      key: apiKey,
    }),
    fetcher,
  );

  const searchItems = search.items ?? [];
  const videoIds = searchItems
    .map((item) => item.id?.videoId)
    .filter((videoId): videoId is string => videoId !== undefined);

  if (videoIds.length === 0) {
    return null;
  }

  const videos = await youtubeRequest<VideoListResponse>(
    "/videos",
    new URLSearchParams({
      part: "snippet,liveStreamingDetails",
      id: videoIds.join(","),
      key: apiKey,
    }),
    fetcher,
  );

  const active = (videos.items ?? [])
    .filter((video) => {
      const details = video.liveStreamingDetails;
      return (
        video.id !== undefined &&
        details !== undefined &&
        details.actualEndTime === undefined
      );
    })
    .sort((left, right) => {
      const leftTime = Date.parse(
        left.liveStreamingDetails?.actualStartTime ?? "",
      );
      const rightTime = Date.parse(
        right.liveStreamingDetails?.actualStartTime ?? "",
      );
      const safeLeft = Number.isNaN(leftTime) ? 0 : leftTime;
      const safeRight = Number.isNaN(rightTime) ? 0 : rightTime;
      return safeRight - safeLeft;
    })[0];

  if (active?.id === undefined) {
    return null;
  }

  const liveChatId = active.liveStreamingDetails?.activeLiveChatId;
  if (liveChatId === undefined) {
    throw new YouTubeApiError(
      "現在のライブ配信ではライブチャットが利用できません。",
      403,
      ["liveChatDisabled"],
    );
  }

  return {
    videoId: active.id,
    title: active.snippet?.title ?? active.id,
    liveChatId,
    actualStartTime:
      normalizeDateTime(active.liveStreamingDetails?.actualStartTime) ?? null,
  };
}

export function parseVideoId(input: string): string {
  const videoId = input.trim();
  if (!VIDEO_ID_PATTERN.test(videoId)) {
    throw new Error("YouTube 動画IDは11文字のIDで指定してください。");
  }
  return videoId;
}

export async function findBroadcastByVideoId(
  apiKey: string,
  input: string,
  expectedChannelId: string,
  fetcher: Fetcher = fetch,
): Promise<ActiveBroadcast> {
  const videoId = parseVideoId(input);
  const videos = await youtubeRequest<VideoListResponse>(
    "/videos",
    new URLSearchParams({
      part: "snippet,liveStreamingDetails",
      id: videoId,
      key: apiKey,
    }),
    fetcher,
  );
  const video = videos.items?.[0];

  if (video?.id !== videoId) {
    throw new YouTubeApiError(
      "指定された YouTube 動画が見つかりませんでした。",
      404,
      ["videoNotFound"],
    );
  }

  if (video.snippet?.channelId !== expectedChannelId) {
    throw new YouTubeApiError(
      "指定された動画は対象チャンネルの配信ではありません。",
      400,
      ["channelMismatch"],
    );
  }

  const details = video.liveStreamingDetails;
  if (
    details?.actualStartTime === undefined ||
    details.actualEndTime !== undefined
  ) {
    throw new YouTubeApiError(
      "指定された動画は現在ライブ配信中ではありません。",
      400,
      ["broadcastNotLive"],
    );
  }

  if (details.activeLiveChatId === undefined) {
    throw new YouTubeApiError(
      "指定されたライブ配信ではライブチャットが利用できません。",
      403,
      ["liveChatDisabled"],
    );
  }

  return {
    videoId,
    title: video.snippet?.title ?? videoId,
    liveChatId: details.activeLiveChatId,
    actualStartTime: normalizeDateTime(details.actualStartTime),
  };
}

export async function listLiveChatMessages(
  apiKey: string,
  liveChatId: string,
  pageToken: string | null,
  fetcher: Fetcher = fetch,
): Promise<LiveChatPage> {
  const params = new URLSearchParams({
    liveChatId,
    part: "id,snippet,authorDetails",
    maxResults: "2000",
    hl: "ja",
    key: apiKey,
  });
  if (pageToken !== null) {
    params.set("pageToken", pageToken);
  }

  const response = await youtubeRequest<LiveChatMessageListResponse>(
    "/liveChat/messages",
    params,
    fetcher,
  );

  return {
    items: response.items ?? [],
    nextPageToken: response.nextPageToken ?? null,
    pollingIntervalMillis: clampPollingInterval(
      response.pollingIntervalMillis ?? 5000,
    ),
    offlineAt: normalizeDateTime(response.offlineAt),
  };
}

export function classifyLiveChatItem(
  item: LiveChatMessageItem,
): LiveChatMutation {
  const type = item.snippet?.type;

  if (type === "chatEndedEvent") {
    return { kind: "ended" };
  }

  if (type === "tombstone" && item.id !== undefined) {
    return { kind: "delete-message", messageId: item.id };
  }

  const deletedMessageId = item.snippet?.messageDeletedDetails?.deletedMessageId;
  if (deletedMessageId !== undefined) {
    return { kind: "delete-message", messageId: deletedMessageId };
  }

  if (type === "userBannedEvent") {
    const bannedChannelId =
      item.snippet?.userBannedDetails?.bannedUserDetails?.channelId;
    if (bannedChannelId !== undefined) {
      return { kind: "delete-author", authorChannelId: bannedChannelId };
    }
    return { kind: "ignore" };
  }

  if (item.snippet?.hasDisplayContent === false) {
    return { kind: "ignore" };
  }

  const id = item.id;
  const name = item.authorDetails?.displayName;
  const message = item.snippet?.displayMessage;
  const createdAt = normalizeDateTime(item.snippet?.publishedAt);

  if (
    id === undefined ||
    name === undefined ||
    name.trim() === "" ||
    message === undefined ||
    message === "" ||
    createdAt === null
  ) {
    return { kind: "ignore" };
  }

  return {
    kind: "upsert",
    comment: {
      id,
      authorChannelId:
        item.authorDetails?.channelId ??
        item.snippet?.authorChannelId ??
        null,
      name,
      message,
      created_at: createdAt,
    },
  };
}

export function normalizeDateTime(value: string | undefined): string | null {
  if (value === undefined || value === "") {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function clampPollingInterval(value: number): number {
  if (!Number.isFinite(value)) {
    return 5000;
  }
  return Math.min(60_000, Math.max(1000, Math.trunc(value)));
}

async function youtubeRequest<T>(
  path: string,
  params: URLSearchParams,
  fetcher: Fetcher,
): Promise<T> {
  const url = new URL(`${YOUTUBE_API_BASE_URL}${path}`);
  url.search = params.toString();

  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Accept: "application/json",
      },
    });
  } catch (error) {
    throw new YouTubeApiError(
      `YouTube API への接続に失敗しました: ${errorMessage(error)}`,
      0,
      ["networkError"],
    );
  }

  const body = await readJsonBody<T | YouTubeErrorResponse>(response);
  if (!response.ok) {
    const errorBody = body as YouTubeErrorResponse | null;
    const reasons = [
      ...(errorBody?.error?.errors ?? [])
        .map((item) => item.reason)
        .filter((reason): reason is string => reason !== undefined),
      ...(errorBody?.error?.status === undefined
        ? []
        : [errorBody.error.status]),
    ];

    throw new YouTubeApiError(
      errorBody?.error?.message ??
        `YouTube API が HTTP ${response.status} を返しました。`,
      response.status,
      [...new Set(reasons)],
    );
  }

  if (body === null) {
    throw new YouTubeApiError(
      "YouTube API の応答が空でした。",
      response.status,
      ["emptyResponse"],
    );
  }

  return body as T;
}

async function readJsonBody<T>(response: Response): Promise<T | null> {
  const text = await response.text();
  if (text === "") {
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new YouTubeApiError(
      "YouTube API の JSON 応答を解析できませんでした。",
      response.status,
      ["invalidJsonResponse"],
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

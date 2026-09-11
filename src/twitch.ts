export const TWITCH_EVENT_TYPES = [
  "channel.chat.message",
  "channel.chat.message_delete",
  "channel.chat.clear_user_messages",
  "channel.chat.clear",
] as const;

export type TwitchEventType = (typeof TWITCH_EVENT_TYPES)[number];

export interface TwitchState {
  enabled: boolean;
  channel: string | null;
  /**
   * Kept for storage/output compatibility with the previous EventSub transport.
   * IRC uses the normalized channel login as the stable source namespace.
   */
  broadcasterId: string | null;
  phase: "stopped" | "waiting" | "running" | "error";
  startedAt: string | null;
  lastReceivedAt: string | null;
  lastError: string | null;
  /** Legacy EventSub field; retained so old persisted state remains readable. */
  subscriptions: Partial<Record<TwitchEventType, string>>;
  flushAt: string | null;
  /** Next allowed IRC reconnect attempt. Missing in legacy persisted state. */
  reconnectAt?: string | null;
}

export function createTwitchState(): TwitchState {
  return {
    enabled: false,
    channel: null,
    broadcasterId: null,
    phase: "stopped",
    startedAt: null,
    lastReceivedAt: null,
    lastError: null,
    subscriptions: {},
    flushAt: null,
    reconnectAt: null,
  };
}

export type TwitchMutation =
  | { kind: "message"; id: string; authorId: string; name: string; message: string }
  | { kind: "delete"; id: string }
  | { kind: "clear-user"; authorId: string }
  | { kind: "clear" };

/**
 * Transport-neutral queue payload. The shape intentionally stays close to the old
 * EventSub delivery so existing durable queue/storage code can be reused during the
 * transport migration.
 */
export interface TwitchDelivery {
  id: string;
  timestamp: string;
  type: TwitchEventType;
  subscriptionId: string;
  broadcasterId: string;
  kind: "notification";
  challenge: null;
  reason: null;
  mutation: TwitchMutation;
}

export type TwitchIrcEvent =
  | { kind: "ping"; payload: string; channel: null }
  | { kind: "reconnect" }
  | { kind: "activity"; channel: string | null }
  | { kind: "notice"; channel: string | null; code: string | null; message: string }
  | { kind: "delivery"; delivery: TwitchDelivery };

export class TwitchRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TWITCH_IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

export function twitchConfig(env: Env) {
  const channel = env.DEFAULT_TWITCH_CHANNEL?.trim().replace(/^#/, "").toLowerCase() ?? "";
  if (!/^[a-z0-9_]{1,25}$/.test(channel)) {
    throw new TwitchRequestError(
      "DEFAULT_TWITCH_CHANNEL にTwitchチャンネル名を設定してください。",
      503,
    );
  }
  return { channel, url: TWITCH_IRC_URL };
}

export function shouldAttemptTwitchReconnect(
  state: TwitchState,
  now = Date.now(),
): boolean {
  const reconnectAt = Date.parse(state.reconnectAt ?? "");
  return !Number.isFinite(reconnectAt) || reconnectAt <= now;
}

export function createGuestNick(random: () => number = Math.random): string {
  return `justinfan${Math.floor(10_000 + random() * 90_000)}`;
}

export function twitchIrcHandshake(channel: string, nick: string): string[] {
  return [
    "CAP REQ :twitch.tv/tags twitch.tv/commands",
    "PASS SCHMOOPIIE",
    `NICK ${nick}`,
    `JOIN #${channel}`,
  ];
}

export function parseTwitchIrcFrame(
  frame: string,
  now: () => number = Date.now,
): TwitchIrcEvent[] {
  const events: TwitchIrcEvent[] = [];
  for (const rawLine of frame.split("\n")) {
    const parsed = parseIrcLine(rawLine, now);
    if (parsed !== null) events.push(parsed);
  }
  return events;
}

interface ParsedLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
  trailing: string;
}

function parseIrcLine(rawLine: string, now: () => number): TwitchIrcEvent | null {
  let rest = rawLine.replace(/\r$/, "").trim();
  if (rest === "") return null;

  let tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    tags = parseIrcTags(rest.slice(1, end));
    rest = rest.slice(end + 1);
  }

  let prefix = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }

  const trailingIndex = rest.indexOf(" :");
  const head = trailingIndex >= 0 ? rest.slice(0, trailingIndex) : rest;
  const trailing = trailingIndex >= 0 ? rest.slice(trailingIndex + 2) : "";
  const parts = head.trim().split(/\s+/).filter(Boolean);
  const command = parts.shift()?.toUpperCase() ?? "";
  if (command === "") return null;
  const line: ParsedLine = { tags, prefix, command, params: parts, trailing };

  if (command === "PING") {
    const payload = trailing !== "" ? `:${trailing}` : parts[0] ?? "";
    return { kind: "ping", payload, channel: null };
  }
  if (command === "RECONNECT") return { kind: "reconnect" };

  const channel = normalizeChannel(parts.find((part) => part.startsWith("#")) ?? "");
  if (command === "NOTICE") {
    return {
      kind: "notice",
      channel: channel || null,
      code: tags["msg-id"] || null,
      message: trailing,
    };
  }

  if (command === "ROOMSTATE" || command === "JOIN" || /^\d{3}$/.test(command)) {
    return { kind: "activity", channel: channel || null };
  }

  if (channel === "") return null;
  if (command === "PRIVMSG") return parsePrivmsg(line, channel, now);
  if (command === "CLEARMSG") return parseClearmsg(line, channel, now);
  if (command === "CLEARCHAT") return parseClearchat(line, channel, now);
  return { kind: "activity", channel };
}

function parsePrivmsg(
  line: ParsedLine,
  channel: string,
  now: () => number,
): TwitchIrcEvent | null {
  const id = bounded(line.tags.id, 256);
  const authorId = bounded(line.tags["user-id"], 256);
  if (id === null || authorId === null) return null;
  const login = line.prefix.split("!")[0] ?? "";
  const name = bounded(line.tags["display-name"] || login, 256);
  if (name === null) return null;
  const timestamp = ircTimestamp(line.tags["tmi-sent-ts"], now);
  return {
    kind: "delivery",
    delivery: makeDelivery(
      id,
      timestamp,
      channel,
      "channel.chat.message",
      { kind: "message", id, authorId, name, message: line.trailing },
    ),
  };
}

function parseClearmsg(
  line: ParsedLine,
  channel: string,
  now: () => number,
): TwitchIrcEvent | null {
  const messageId = bounded(line.tags["target-msg-id"], 256);
  if (messageId === null) return null;
  const timestamp = ircTimestamp(line.tags["tmi-sent-ts"], now);
  return {
    kind: "delivery",
    delivery: makeDelivery(
      `clearmsg:${messageId}:${timestamp}`,
      timestamp,
      channel,
      "channel.chat.message_delete",
      { kind: "delete", id: messageId },
    ),
  };
}

function parseClearchat(
  line: ParsedLine,
  channel: string,
  now: () => number,
): TwitchIrcEvent {
  const timestamp = ircTimestamp(line.tags["tmi-sent-ts"], now);
  const targetUserId = bounded(line.tags["target-user-id"], 256);
  if (targetUserId !== null) {
    return {
      kind: "delivery",
      delivery: makeDelivery(
        `clearchat:${targetUserId}:${timestamp}`,
        timestamp,
        channel,
        "channel.chat.clear_user_messages",
        { kind: "clear-user", authorId: targetUserId },
      ),
    };
  }
  return {
    kind: "delivery",
    delivery: makeDelivery(
      `clearchat:${timestamp}`,
      timestamp,
      channel,
      "channel.chat.clear",
      { kind: "clear" },
    ),
  };
}

function makeDelivery(
  id: string,
  timestamp: string,
  channel: string,
  type: TwitchEventType,
  mutation: TwitchMutation,
): TwitchDelivery {
  return {
    id,
    timestamp,
    type,
    subscriptionId: "irc",
    broadcasterId: channel,
    kind: "notification",
    challenge: null,
    reason: null,
    mutation,
  };
}

function parseIrcTags(raw: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    const key = separator < 0 ? part : part.slice(0, separator);
    if (key !== "") {
      tags[key] = decodeIrcTag(separator < 0 ? "" : part.slice(separator + 1));
    }
  }
  return tags;
}

function decodeIrcTag(value: string): string {
  let output = "";
  const escapes: Record<string, string> = {
    s: " ",
    ":": ";",
    r: "\r",
    n: "\n",
    "\\": "\\",
  };
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charAt(index);
    if (current !== "\\") {
      output += current;
      continue;
    }
    const next = value.charAt(++index);
    output += escapes[next] ?? next;
  }
  return output;
}

function normalizeChannel(value: string): string {
  return value.replace(/^#/, "").toLowerCase();
}

function ircTimestamp(raw: string | undefined, now: () => number): string {
  const parsed = Number(raw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : now();
  return new Date(value).toISOString();
}

function bounded(value: string | undefined, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;
}

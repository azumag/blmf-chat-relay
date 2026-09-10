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
  broadcasterId: string | null;
  phase: "stopped" | "waiting" | "running" | "error";
  startedAt: string | null;
  lastReceivedAt: string | null;
  lastError: string | null;
  subscriptions: Partial<Record<TwitchEventType, string>>;
  flushAt: string | null;
}

export function createTwitchState(): TwitchState {
  return {
    enabled: false, channel: null, broadcasterId: null, phase: "stopped",
    startedAt: null, lastReceivedAt: null, lastError: null, subscriptions: {}, flushAt: null,
  };
}

export type TwitchMutation =
  | { kind: "message"; id: string; authorId: string; name: string; message: string }
  | { kind: "delete"; id: string }
  | { kind: "clear-user"; authorId: string }
  | { kind: "clear" };

export interface TwitchDelivery {
  id: string;
  timestamp: string;
  type: TwitchEventType;
  subscriptionId: string;
  broadcasterId: string;
  kind: "notification" | "webhook_callback_verification" | "revocation";
  challenge: string | null;
  reason: string | null;
  mutation: TwitchMutation | null;
}

export class TwitchRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function twitchConfig(env: Env) {
  const channel = env.DEFAULT_TWITCH_CHANNEL?.trim().toLowerCase() ?? "";
  const broadcasterId = env.TWITCH_BROADCASTER_ID?.trim() ?? "";
  const secret = env.TWITCH_EVENTSUB_SECRET;
  if (!/^[a-z0-9_]{1,25}$/.test(channel) || !/^\d+$/.test(broadcasterId) ||
      typeof secret !== "string" || !/^[\x21-\x7e]{10,100}$/.test(secret)) {
    throw new TwitchRequestError("Twitchの初期設定が必要です。docs/twitch.md を確認してください。", 503);
  }
  return { channel, broadcasterId, secret };
}

// Read a bounded raw body: HMAC must cover the exact bytes, before parsing JSON.
export async function readTwitchDelivery(request: Request, env: Env): Promise<TwitchDelivery> {
  const now = Date.now();
  const config = twitchConfig(env);
  const id = request.headers.get("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = request.headers.get("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = request.headers.get("Twitch-Eventsub-Message-Signature") ?? "";
  const sentAt = Date.parse(timestamp);
  if (!id || id.length > 256 || !Number.isFinite(sentAt) ||
      now - sentAt > 600_000 || sentAt - now > 60_000 ||
      !/^sha256=[0-9a-f]{64}$/.test(signature)) {
    throw new TwitchRequestError("Invalid Twitch signature or timestamp", 403);
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65_536) {
        await reader.cancel();
        throw new TwitchRequestError("Twitch payload too large", 413);
      }
      chunks.push(value);
    }
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  const prefix = new TextEncoder().encode(id + timestamp);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix); signed.set(raw, prefix.length);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const digest = Uint8Array.from(signature.slice(7).match(/../g)!, (hex) => parseInt(hex, 16));
  if (!await crypto.subtle.verify("HMAC", key, digest, signed)) {
    throw new TwitchRequestError("Invalid Twitch signature", 403);
  }
  let body: Record<string, unknown>;
  try { body = object(JSON.parse(new TextDecoder().decode(raw))); }
  catch { throw new TwitchRequestError("Invalid Twitch JSON", 400); }
  const subscription = object(body.subscription);
  const condition = object(subscription.condition);
  const type = subscription.type;
  if (!TWITCH_EVENT_TYPES.includes(type as TwitchEventType) || subscription.version !== "1" ||
      request.headers.get("Twitch-Eventsub-Subscription-Type") !== type ||
      request.headers.get("Twitch-Eventsub-Subscription-Version") !== "1" ||
      condition.broadcaster_user_id !== config.broadcasterId) {
    throw new TwitchRequestError("Unexpected Twitch subscription", 403);
  }
  const kind = request.headers.get("Twitch-Eventsub-Message-Type");
  if (kind !== "notification" && kind !== "webhook_callback_verification" && kind !== "revocation") {
    throw new TwitchRequestError("Unexpected Twitch message type", 400);
  }
  // The message-type header itself is not covered by Twitch's HMAC.
  const status = subscription.status;
  if ((kind === "notification" && status !== "enabled") ||
      (kind === "webhook_callback_verification" && status !== "webhook_callback_verification_pending") ||
      (kind === "revocation" && !["authorization_revoked", "user_removed", "version_removed", "notification_failures_exceeded"].includes(String(status)))) {
    throw new TwitchRequestError("Unexpected Twitch subscription status", 400);
  }
  let mutation: TwitchMutation | null = null;
  if (kind === "notification") {
    const event = object(body.event);
    // Check only the immutable id, not broadcaster_user_login: a channel rename would
    // otherwise 403 every notification (login still matches the id, just not the
    // possibly-stale DEFAULT_TWITCH_CHANNEL config) until redeployed with the new
    // login, and Twitch counts repeated failures toward revoking all four subscriptions.
    if (event.broadcaster_user_id !== config.broadcasterId) {
      throw new TwitchRequestError("Unexpected Twitch channel", 403);
    }
    switch (type) {
      case "channel.chat.message":
        mutation = { kind: "message", id: field(event.message_id), authorId: field(event.chatter_user_id),
          name: field(event.chatter_user_name), message: field(object(event.message).text) };
        break;
      case "channel.chat.message_delete": mutation = { kind: "delete", id: field(event.message_id) }; break;
      case "channel.chat.clear_user_messages": mutation = { kind: "clear-user", authorId: field(event.target_user_id) }; break;
      case "channel.chat.clear": mutation = { kind: "clear" }; break;
    }
  }
  return {
    id, timestamp: new Date(sentAt).toISOString(), type: type as TwitchEventType,
    subscriptionId: field(subscription.id), broadcasterId: config.broadcasterId, kind,
    challenge: kind === "webhook_callback_verification" ? field(body.challenge) : null,
    reason: kind === "revocation" ? field(subscription.status) : null, mutation,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TwitchRequestError("Invalid Twitch payload", 400);
  }
  return value as Record<string, unknown>;
}

function field(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw new TwitchRequestError("Invalid Twitch field", 400);
  }
  return value;
}

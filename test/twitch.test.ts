import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTwitchDelivery, TWITCH_EVENT_TYPES, type TwitchDelivery, type TwitchEventType } from "../src/twitch";
import { applyChatItems, applyTwitchDelivery, getCommentDelta, initializeRelayStorage, listComments, loadRelayState, saveRelayState } from "../src/relay-storage";
import { createRunningState, createStoppedState } from "../src/types";
import { nextRelayAlarm } from "../src/relay-schedule";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));
import { YouTubeChatRelay } from "../src/relay";
import worker from "../src/index";

const time = "2026-09-10T00:00:00.000Z";
const nodeRuntime = globalThis as typeof globalThis & { process: { getBuiltinModule(name: string): unknown } };
const { DatabaseSync } = nodeRuntime.process.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(query: string): void;
    prepare(query: string): { all(...bindings: (string | number | null)[]): Array<Record<string, unknown>> };
    close(): void;
  };
};
const databases: Array<{ close(): void }> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(time)); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let alarm: number | null = null;
  const storage = {
    sql: { exec(query: string, ...bindings: (string | number | null)[]) {
      if (query.split(";").filter((part) => part.trim()).length > 1) { db.exec(query); return { toArray: () => [] }; }
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows };
    } },
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => { alarm = value; },
    deleteAlarm: async () => { alarm = null; },
    transactionSync<T>(callback: () => T): T {
      db.exec("BEGIN");
      try { const value = callback(); db.exec("COMMIT"); return value; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async transaction<T>(callback: (transaction: Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">) => Promise<T>): Promise<T> {
      // Real SQLite for writes; the Worker runtime test also checks actual input gates/alarms.
      return callback({ getAlarm: storage.getAlarm, setAlarm: async (value) => storage.setAlarm(Number(value)), deleteAlarm: storage.deleteAlarm });
    },
  };
  const durableStorage = storage as unknown as DurableObjectStorage;
  const objects = new Map<string, string>();
  const put = vi.fn(async (key: string, body: string) => { objects.set(key, body); return {}; });
  const env = {
    DEFAULT_TWITCH_CHANNEL: "azumagbanjo", TWITCH_BROADCASTER_ID: "123",
    TWITCH_EVENTSUB_SECRET: "test-only-eventsub-secret", ADMIN_TOKEN: "test-admin", YOUTUBE_API_KEY: "test-youtube",
    PUBLIC_R2_BASE_URL: "https://chat.blmf.bluemoon.works", R2_CURRENT_OBJECT_KEY: "comments.json",
    R2_STATUS_OBJECT_KEY: "status.json", R2_FLUSH_INTERVAL_SECONDS: "15", DISCOVERY_INTERVAL_SECONDS: "300",
    COMMENTS_BUCKET: { put, get: async (key: string) => objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null },
  } as unknown as Env;
  const ctx = { storage: durableStorage, blockConcurrencyWhile: async (callback: () => Promise<void>) => callback() } as unknown as DurableObjectState;
  const relay = new YouTubeChatRelay(ctx, env);
  env.CHAT_RELAY = { getByName: () => relay } as unknown as Env["CHAT_RELAY"];
  return { relay, env, storage: durableStorage, objects, put };
}

function delivery(type: TwitchEventType = "channel.chat.message", overrides: Partial<TwitchDelivery> = {}): TwitchDelivery {
  return { id: crypto.randomUUID(), timestamp: time, type, subscriptionId: type, broadcasterId: "123",
    kind: "notification", challenge: null, reason: null,
    mutation: { kind: "message", id: "msg1", authorId: "viewer1", name: "視聴者", message: "こんばんは！" }, ...overrides };
}

async function register(relay: YouTubeChatRelay) {
  for (const type of TWITCH_EVENT_TYPES) await relay.receiveTwitch(delivery(type, { kind: "webhook_callback_verification", challenge: "hello", mutation: null }));
  await relay.status();
}

async function signedRequest(env: Env, options: { body?: unknown; timestamp?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const timestamp = options.timestamp ?? time;
  const id = "delivery-1";
  const raw = options.raw ?? JSON.stringify(options.body ?? {
    subscription: { id: "sub-1", type: "channel.chat.message", version: "1", status: "enabled", condition: { broadcaster_user_id: "123" } },
    event: { broadcaster_user_id: "123", broadcaster_user_login: "azumagbanjo", message_id: "msg1", chatter_user_id: "viewer1",
      chatter_user_name: "視聴者", message: { text: "こんばんは！" } },
  });
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.TWITCH_EVENTSUB_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(id + timestamp + raw));
  const signature = "sha256=" + [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://relay.example/api/twitch/eventsub", { method: "POST", body: raw, headers: {
    "Twitch-Eventsub-Message-Id": id, "Twitch-Eventsub-Message-Timestamp": timestamp, "Twitch-Eventsub-Message-Signature": signature,
    "Twitch-Eventsub-Message-Type": "notification", "Twitch-Eventsub-Subscription-Type": "channel.chat.message",
    "Twitch-Eventsub-Subscription-Version": "1", ...options.headers,
  } });
}

describe("Twitch webhook trust boundary", () => {
  it("accepts a signed UTF-8 message and rejects tampered signatures", async () => {
    const { env } = fixture();
    const result = await readTwitchDelivery(await signedRequest(env), env);
    expect(result.mutation).toMatchObject({ message: "こんばんは！", name: "視聴者" });
    await expect(readTwitchDelivery(await signedRequest(env, { headers: { "Twitch-Eventsub-Message-Signature": "sha256=" + "0".repeat(64) } }), env)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects old/future notifications, wrong channels, unsupported types, and malformed bodies", async () => {
    const { env } = fixture();
    for (const timestamp of ["2026-09-09T23:49:59Z", "2026-09-10T00:01:01Z"]) {
      await expect(readTwitchDelivery(await signedRequest(env, { timestamp }), env)).rejects.toMatchObject({ status: 403 });
    }
    const wrong = await signedRequest(env, { body: { subscription: { id: "s", type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: "456" } } } });
    await expect(readTwitchDelivery(wrong, env)).rejects.toMatchObject({ status: 403 });
    await expect(readTwitchDelivery(await signedRequest(env, { raw: "{" }), env)).rejects.toMatchObject({ status: 400 });
    await expect(readTwitchDelivery(await signedRequest(env, { raw: "x".repeat(65_537) }), env)).rejects.toMatchObject({ status: 413 });
    await expect(readTwitchDelivery(await signedRequest(env, { headers: { "Twitch-Eventsub-Subscription-Type": "channel.follow" } }), env)).rejects.toMatchObject({ status: 403 });
    await expect(readTwitchDelivery(await signedRequest(env, { headers: { "Twitch-Eventsub-Message-Type": "revocation" } }), env)).rejects.toMatchObject({ status: 400 });
  });
  it("returns a plain challenge, leaves pre-live samples untouched, and protects controls", async () => {
    const { env, objects, relay } = fixture();
    objects.set("comments.json", "[{\"name\":\"sample\",\"message\":\"hello\",\"created_at\":\"2026-01-01T00:00:00Z\"}]");
    const request = await signedRequest(env, { body: { challenge: "challenge-text", subscription: {
      id: "sub-1", type: "channel.chat.message", version: "1", status: "webhook_callback_verification_pending", condition: { broadcaster_user_id: "123" },
    } }, headers: { "Twitch-Eventsub-Message-Type": "webhook_callback_verification" } });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-text");
    await relay.alarm();
    expect(objects.get("comments.json")).toContain("sample");
    const unauthorized = await worker.fetch(new Request("https://relay.example/api/twitch/start", { method: "POST" }), env);
    expect(unauthorized.status).toBe(401);
  });
});

describe("merged relay lifecycle", () => {
  it("drains a burst completely before stopping and publishing the final snapshot", async () => {
    const { relay, objects } = fixture();
    await register(relay); await relay.startTwitch();
    for (let index = 0; index < 205; index++) {
      await relay.receiveTwitch(delivery("channel.chat.message", {
        mutation: { kind: "message", id: `burst-${index}`, authorId: "v", name: "viewer", message: String(index) },
      }));
    }
    await relay.stopTwitch();
    expect(JSON.parse(objects.get("comments.json")!)).toHaveLength(205);
  });
  it("acknowledges the durable queue while R2 is blocked, then processes the pending event", async () => {
    const { relay, put } = fixture();
    await register(relay);
    let release!: () => void;
    let entered!: () => void;
    const inR2 = new Promise<void>((resolve) => { entered = resolve; });
    put.mockImplementationOnce(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return {}; });
    const start = relay.startTwitch();
    await inR2;
    try { await relay.receiveTwitch(delivery()); }
    finally { release(); }
    await start;
    expect((await relay.commentsDeltaSimple(50)).events).toHaveLength(1);
  });
  it("persists messages and duplicates once, then publishes R2 even without another event", async () => {
    const { relay, storage, objects } = fixture();
    await register(relay);
    expect((await relay.startTwitch()).twitch.phase).toBe("running");
    const event = delivery();
    await relay.receiveTwitch(event);
    await relay.receiveTwitch(event);
    const delta = await relay.commentsDeltaSimple(50);
    expect(delta.events.map((e) => e.id)).toEqual(["twitch:123:msg1"]);
    expect(await storage.getAlarm()).toBe(Date.parse(time) + 15_000);
    vi.advanceTimersByTime(15_000);
    await relay.alarm();
    expect(JSON.parse(objects.get("comments.json")!)).toEqual([{ name: "視聴者", message: "こんばんは！", created_at: time }]);
    expect(await storage.getAlarm()).toBeNull();
  });
  it("keeps Twitch and the run across YouTube start/stop, without premature YouTube polls", async () => {
    const { relay, storage } = fixture();
    await register(relay); await relay.startTwitch(); await relay.receiveTwitch(delivery());
    const initial = await relay.commentsDeltaSimple(50);
    await relay.start("@example");
    expect((await relay.commentsDeltaSimple(50)).streamId).toBe(initial.streamId);
    const state = loadRelayState(storage);
    saveRelayState(storage, { ...state, nextActionAt: new Date(Date.now() + 300_000).toISOString() });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await relay.receiveTwitch(delivery("channel.chat.message", { mutation: { kind: "message", id: "msg2", authorId: "v2", name: "two", message: "hi" } }));
    await relay.status(); vi.advanceTimersByTime(15_000); await relay.alarm();
    expect(fetch).not.toHaveBeenCalled();
    expect(await storage.getAlarm()).toBe(Date.parse(time) + 300_000);
    await relay.stop();
    expect((await relay.status()).twitch.enabled).toBe(true);
    await relay.receiveTwitch(delivery("channel.chat.message", { timestamp: new Date().toISOString(), mutation: { kind: "message", id: "msg3", authorId: "v3", name: "three", message: "still here" } }));
    expect((await relay.commentsDeltaSimple(50)).events).toHaveLength(3);
  });
  it("retries failed R2 writes and survives recreation of the Durable Object", async () => {
    const { relay, storage, env, put, objects } = fixture();
    await register(relay); await relay.startTwitch(); await relay.receiveTwitch(delivery());
    await relay.status(); vi.advanceTimersByTime(15_000);
    put.mockRejectedValueOnce(new Error("temporary R2 failure"));
    await relay.alarm();
    expect(await storage.getAlarm()).toBe(Date.now() + 30_000);
    const recovered = new YouTubeChatRelay({ storage, blockConcurrencyWhile: async (fn: () => Promise<void>) => fn() } as unknown as DurableObjectState, env);
    vi.advanceTimersByTime(30_000); await recovered.alarm();
    expect(JSON.parse(objects.get("comments.json")!)).toHaveLength(1);
    expect((await recovered.status()).lastError).toBeNull();
  });
  it("ignores stopped and pre-restart deliveries and surfaces subscription revocation", async () => {
    const { relay } = fixture();
    await register(relay); await relay.startTwitch(); await relay.stopTwitch();
    await relay.receiveTwitch(delivery());
    expect((await relay.commentsDeltaSimple(50)).events).toHaveLength(0);
    vi.advanceTimersByTime(5000); await relay.startTwitch();
    await relay.receiveTwitch(delivery());
    expect((await relay.commentsDeltaSimple(50)).events).toHaveLength(0);
    await relay.receiveTwitch(delivery("channel.chat.message", { kind: "revocation", mutation: null, reason: "authorization_revoked" }));
    expect((await relay.status()).twitch).toMatchObject({ phase: "error", ready: false });
  });
  it("migrates pre-Twitch state and selects the earliest independent alarm", () => {
    const { storage } = fixture();
    const state = createStoppedState();
    const { twitch: _, ...old } = state;
    storage.sql.exec("UPDATE relay_state SET data = ? WHERE id = 1", JSON.stringify(old));
    expect(loadRelayState(storage).twitch.enabled).toBe(false);
    const running = createRunningState("@example", time);
    running.nextActionAt = "2026-09-10T00:05:00Z";
    running.twitch.flushAt = "2026-09-10T00:00:15Z";
    expect(nextRelayAlarm(running)).toBe(Date.parse(time) + 15_000);
  });
});

describe("Twitch moderation and ordering", () => {
  it("merges platforms and clears only Twitch, emits deletes, and blocks delayed resurrection", () => {
    const { storage } = fixture(); initializeRelayStorage(storage);
    applyChatItems(storage, "run", [{ id: "msg1", snippet: { publishedAt: time, displayMessage: "YouTube" }, authorDetails: { displayName: "viewer", channelId: "viewer1" } }]);
    applyTwitchDelivery(storage, "run", delivery());
    applyTwitchDelivery(storage, "run", delivery("channel.chat.clear", { mutation: { kind: "clear" } }));
    applyTwitchDelivery(storage, "run", delivery());
    expect(listComments(storage, "run").map((comment) => comment.message)).toEqual(["YouTube"]);
    expect(getCommentDelta(storage, "run", "run", 0, 50).events.map((event) => event.type)).toEqual(["upsert", "upsert", "delete"]);
  });
  it("handles deletion before arrival, user clears, and messages newer than a clear", () => {
    const { storage } = fixture();
    applyTwitchDelivery(storage, "run", delivery("channel.chat.message_delete", { mutation: { kind: "delete", id: "msg1" } }));
    applyTwitchDelivery(storage, "run", delivery());
    expect(listComments(storage, "run")).toEqual([]);
    const fresh = delivery("channel.chat.message", { mutation: { kind: "message", id: "msg2", authorId: "viewer1", name: "v", message: "new" }, timestamp: "2026-09-10T00:00:05Z" });
    applyTwitchDelivery(storage, "run", fresh);
    applyTwitchDelivery(storage, "run", delivery("channel.chat.clear_user_messages", { mutation: { kind: "clear-user", authorId: "viewer1" } }));
    expect(listComments(storage, "run")).toHaveLength(1);
    applyTwitchDelivery(storage, "run", delivery("channel.chat.clear_user_messages", { mutation: { kind: "clear-user", authorId: "viewer1" }, timestamp: "2026-09-10T00:00:10Z" }));
    applyTwitchDelivery(storage, "run", fresh);
    expect(listComments(storage, "run")).toEqual([]);
  });
});

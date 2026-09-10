import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TWITCH_EVENT_TYPES, type TwitchDelivery, type TwitchEventType } from "../src/twitch";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));
import { YouTubeChatRelay } from "../src/relay";

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

function delivery(type: TwitchEventType, message: string, overrides: Partial<TwitchDelivery> = {}): TwitchDelivery {
  return { id: crypto.randomUUID(), timestamp: new Date().toISOString(), type, subscriptionId: type, broadcasterId: "123",
    kind: "notification", challenge: null, reason: null,
    mutation: { kind: "message", id: crypto.randomUUID(), authorId: "viewer1", name: "視聴者", message }, ...overrides };
}

async function register(relay: YouTubeChatRelay) {
  for (const type of TWITCH_EVENT_TYPES) {
    await relay.receiveTwitch({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), type, subscriptionId: type,
      broadcasterId: "123", kind: "webhook_callback_verification", challenge: "hello", reason: null, mutation: null });
  }
  await relay.status();
}

describe("Twitch archive path (per-run archiveChannel)", () => {
  it("archives comments received after the last periodic flush, up to stop", async () => {
    const { relay, objects } = fixture();

    await relay.startTwitch();
    await register(relay);

    await relay.receiveTwitch(delivery("channel.chat.message", "one"));
    await relay.alarm(); // periodic flush fires immediately (lastFlushAt was null)

    vi.setSystemTime(new Date(Date.parse(time) + 5_000)); // well within the 15s flush window
    await relay.receiveTwitch(delivery("channel.chat.message", "two"));

    await relay.stopTwitch();

    const archiveKey = [...objects.keys()].find((key) => key.startsWith("streams/twitch-"));
    expect(archiveKey).toBeDefined();
    const archived = JSON.parse(objects.get(archiveKey!)!) as Array<{ message: string }>;
    const messages = archived.map((c) => c.message);
    // stopTwitch() must flush the tail of the run (comments since the last periodic
    // flush) to the archive before it becomes unreachable via archiveObjectKey().
    expect(messages).toContain("one");
    expect(messages).toContain("two");
  });

  it("does not leak a stopped Twitch run's channel into a later, unrelated run's archive path", async () => {
    const { relay } = fixture();

    await relay.startTwitch();
    await register(relay);
    await relay.receiveTwitch(delivery("channel.chat.message", "one"));
    await relay.alarm();
    vi.setSystemTime(new Date(Date.parse(time) + 5_000));
    await relay.receiveTwitch(delivery("channel.chat.message", "two"));
    await relay.stopTwitch();

    // stopTwitch() never clears twitch.channel (it's a display field), so a later,
    // unrelated YouTube-only run must not resolve its own pre-discovery archive path
    // (videoId still null) against that stale channel.
    await relay.start("@some-channel");
    const status = await relay.status();
    expect(status.urls.archive).toBeNull();
  });
});

describe("drainTwitch robustness", () => {
  it("drops a single malformed pending delivery instead of wedging the Durable Object", async () => {
    const { relay, storage } = fixture();

    await relay.startTwitch();
    await register(relay);

    // Simulate a delivery that somehow can't be applied (corrupted queue row) sitting
    // ahead of a normal one. Before this fix, one throwing row rolled back the whole
    // transactionSync batch's deletes, so every future runSerially() call (status,
    // deltas, start/stop, alarm) re-threw on the same row forever.
    storage.sql.exec("INSERT INTO twitch_pending (delivery) VALUES (?)", "not valid json");
    await relay.receiveTwitch(delivery("channel.chat.message", "still works"));

    // Neither this call nor any later one should throw.
    const status = await relay.status();
    expect(status.twitch.phase).toBe("running");

    const stillPending = storage.sql.exec("SELECT seq FROM twitch_pending").toArray();
    expect(stillPending).toHaveLength(0); // the poison row was deleted, not retried forever

    await expect(relay.stopTwitch()).resolves.toBeDefined();
  });
});

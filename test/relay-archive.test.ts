import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TwitchDelivery, TwitchEventType } from "../src/twitch";
import { loadRelayState, saveRelayState } from "../src/relay-storage";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(protected ctx: DurableObjectState, protected env: Env) {}
  },
}));
import { YouTubeChatRelay } from "../src/relay";

const time = "2026-09-10T00:00:00.000Z";
const nodeRuntime = globalThis as typeof globalThis & {
  process: { getBuiltinModule(name: string): unknown };
};
const { DatabaseSync } = nodeRuntime.process.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(query: string): void;
    prepare(query: string): {
      all(...bindings: (string | number | null)[]): Array<Record<string, unknown>>;
    };
    close(): void;
  };
};
const databases: Array<{ close(): void }> = [];

class FakeWebSocket {
  readyState = 0;
  addEventListener() {}
  send() {}
  close() {
    this.readyState = 3;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(time));
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let alarm: number | null = null;
  const waits: Promise<unknown>[] = [];
  const storage = {
    sql: {
      exec(query: string, ...bindings: (string | number | null)[]) {
        if (query.split(";").filter((part) => part.trim()).length > 1) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
    getAlarm: async () => alarm,
    setAlarm: async (value: number) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    transactionSync<T>(callback: () => T): T {
      db.exec("BEGIN");
      try {
        const value = callback();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async transaction<T>(
      callback: (
        transaction: Pick<DurableObjectStorage, "getAlarm" | "setAlarm" | "deleteAlarm">,
      ) => Promise<T>,
    ): Promise<T> {
      return callback({
        getAlarm: storage.getAlarm,
        setAlarm: async (value) => storage.setAlarm(Number(value)),
        deleteAlarm: storage.deleteAlarm,
      });
    },
  };
  const durableStorage = storage as unknown as DurableObjectStorage;
  const objects = new Map<string, string>();
  const put = vi.fn(async (key: string, body: string) => {
    objects.set(key, body);
    return {};
  });
  const env = {
    DEFAULT_TWITCH_CHANNEL: "azumagbanjo",
    ADMIN_TOKEN: "test-admin",
    YOUTUBE_API_KEY: "test-youtube",
    DEFAULT_YOUTUBE_CHANNEL: "",
    PUBLIC_R2_BASE_URL: "https://chat.blmf.bluemoon.works",
    R2_CURRENT_OBJECT_KEY: "comments.json",
    R2_STATUS_OBJECT_KEY: "status.json",
    R2_FLUSH_INTERVAL_SECONDS: "15",
    DISCOVERY_INTERVAL_SECONDS: "300",
    COMMENTS_BUCKET: {
      put,
      get: async (key: string) =>
        objects.has(key)
          ? { json: async () => JSON.parse(objects.get(key)!) }
          : null,
    },
  } as unknown as Env;
  const ctx = {
    storage: durableStorage,
    blockConcurrencyWhile: async (callback: () => Promise<void>) => callback(),
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  } as unknown as DurableObjectState;
  const relay = new YouTubeChatRelay(ctx, env);
  env.CHAT_RELAY = {
    getByName: () => relay,
  } as unknown as Env["CHAT_RELAY"];
  return { relay, storage: durableStorage, objects };
}

function delivery(
  type: TwitchEventType,
  message: string,
  overrides: Partial<TwitchDelivery> = {},
): TwitchDelivery {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    subscriptionId: "irc",
    broadcasterId: "azumagbanjo",
    kind: "notification",
    challenge: null,
    reason: null,
    mutation: {
      kind: "message",
      id: crypto.randomUUID(),
      authorId: "viewer1",
      name: "視聴者",
      message,
    },
    ...overrides,
  };
}

describe("Twitch archive path (per-run archiveChannel)", () => {
  it("archives comments received after the last periodic flush, up to stop", async () => {
    const { relay, objects } = fixture();
    await relay.startTwitch();
    await relay.receiveTwitch(delivery("channel.chat.message", "one"));
    await relay.alarm();

    vi.setSystemTime(new Date(Date.parse(time) + 5_000));
    await relay.receiveTwitch(delivery("channel.chat.message", "two"));
    await relay.stopTwitch();

    const archiveKey = [...objects.keys()].find((key) =>
      key.startsWith("streams/twitch-"),
    );
    expect(archiveKey).toBeDefined();
    const archived = JSON.parse(objects.get(archiveKey!)!) as Array<{
      message: string;
    }>;
    expect(archived.map((comment) => comment.message)).toEqual(
      expect.arrayContaining(["one", "two"]),
    );
  });

  it("does not leak a stopped Twitch channel into a later unrelated run", async () => {
    const { relay } = fixture();
    await relay.startTwitch();
    await relay.receiveTwitch(delivery("channel.chat.message", "one"));
    await relay.alarm();
    await relay.stopTwitch();

    await relay.start("@some-channel");
    expect((await relay.status()).urls.archive).toBeNull();
  });

  it("rolls to a fresh run for each new YouTube broadcast while IRC stays enabled", async () => {
    const { relay, storage } = fixture();
    await relay.startTwitch();
    await relay.receiveTwitch(delivery("channel.chat.message", "twitch-only chat"));

    const before = loadRelayState(storage);
    saveRelayState(storage, {
      ...before,
      enabled: true,
      videoId: "V1",
      phase: "running",
    });
    const firstRunId = loadRelayState(storage).runId;
    await relay.stop("manual");
    expect(loadRelayState(storage).twitch.enabled).toBe(true);

    await relay.start("@example");
    const next = loadRelayState(storage);
    expect(next.runId).not.toBe(firstRunId);
    expect(next.videoId).toBeNull();
    expect(next.archiveChannel).toBe("azumagbanjo");
    await relay.receiveTwitch(delivery("channel.chat.message", "post-roll chat"));
    expect((await relay.status()).urls.archive).toContain("twitch-azumagbanjo");
  });
});

describe("drainTwitch robustness", () => {
  it("drops a malformed pending IRC event instead of wedging the Durable Object", async () => {
    const { relay, storage } = fixture();
    await relay.startTwitch();
    storage.sql.exec(
      "INSERT INTO twitch_pending (delivery) VALUES (?)",
      "not valid json",
    );
    await relay.receiveTwitch(delivery("channel.chat.message", "still works"));

    const status = await relay.status();
    expect(status.twitch.enabled).toBe(true);
    expect(
      storage.sql.exec("SELECT seq FROM twitch_pending").toArray(),
    ).toHaveLength(0);
    await expect(relay.stopTwitch()).resolves.toBeDefined();
  });
});

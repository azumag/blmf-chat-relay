import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGuestNick,
  parseTwitchIrcFrame,
  twitchIrcHandshake,
  twitchSourceNamespace,
  type TwitchDelivery,
  type TwitchEventType,
} from "../src/twitch";
import {
  applyChatItems,
  applyTwitchDelivery,
  getCommentDelta,
  initializeRelayStorage,
  listComments,
  loadRelayState,
  saveRelayState,
} from "../src/relay-storage";
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
const millis = Date.parse(time);
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
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  private listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }

  send(value: string) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(value);
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.emit("close", {});
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: string) {
    this.emit("message", { data });
  }

  error() {
    this.emit("error", {});
  }

  private emit(type: string, event: { data?: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  static latest(): FakeWebSocket {
    const socket = this.instances.at(-1);
    if (!socket) throw new Error("no fake websocket");
    return socket;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(time));
  FakeWebSocket.instances = [];
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
    waitUntil: (promise: Promise<unknown>) => {
      waits.push(promise);
    },
  } as unknown as DurableObjectState;
  const relay = new YouTubeChatRelay(ctx, env);
  env.CHAT_RELAY = {
    getByName: () => relay,
  } as unknown as Env["CHAT_RELAY"];
  const flushWaits = async () => {
    while (waits.length) await Promise.all(waits.splice(0));
  };
  return { relay, env, storage: durableStorage, objects, put, flushWaits };
}

function delivery(
  type: TwitchEventType = "channel.chat.message",
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
      id: "msg1",
      authorId: "viewer1",
      name: "視聴者",
      message: "こんばんは！",
    },
    ...overrides,
  };
}

function roomState(channel = "azumagbanjo") {
  return `@room-id=1 :tmi.twitch.tv ROOMSTATE #${channel}\r\n`;
}

async function startConnected(
  relay: YouTubeChatRelay,
  flushWaits: () => Promise<void>,
) {
  const started = await relay.startTwitch();
  expect(started.twitch.phase).toBe("waiting");
  const socket = FakeWebSocket.latest();
  expect(socket.url).toBe("wss://irc-ws.chat.twitch.tv:443");
  socket.open();
  expect(socket.sent[0]).toBe("CAP REQ :twitch.tv/tags twitch.tv/commands");
  expect(socket.sent[1]).toBe("PASS SCHMOOPIIE");
  expect(socket.sent[2]).toMatch(/^NICK justinfan\d{5}$/);
  expect(socket.sent[3]).toBe("JOIN #azumagbanjo");

  // Server welcome alone does not prove JOIN succeeded.
  socket.message(":tmi.twitch.tv 001 guest :Welcome, GLHF!\r\n");
  await flushWaits();
  expect((await relay.status()).twitch).toMatchObject({
    enabled: true,
    phase: "waiting",
    ready: false,
  });

  socket.message(roomState());
  await flushWaits();
  expect((await relay.status()).twitch).toMatchObject({
    enabled: true,
    phase: "running",
    ready: true,
  });
  return socket;
}

describe("Twitch IRC parser", () => {
  it("creates anonymous credentials and parses PRIVMSG with stable Twitch metadata", () => {
    expect(createGuestNick(() => 0)).toBe("justinfan10000");
    expect(twitchIrcHandshake("azumagbanjo", "justinfan12345")).toEqual([
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "PASS SCHMOOPIIE",
      "NICK justinfan12345",
      "JOIN #azumagbanjo",
    ]);
    const [event] = parseTwitchIrcFrame(
      "@display-name=視聴者;id=abc;user-id=42;tmi-sent-ts=1788998400123 :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #azumagbanjo :こんばんは！\r\n",
    );
    expect(event).toMatchObject({
      kind: "delivery",
      delivery: {
        id: "abc",
        broadcasterId: "azumagbanjo",
        type: "channel.chat.message",
        mutation: {
          kind: "message",
          id: "abc",
          authorId: "42",
          name: "視聴者",
          message: "こんばんは！",
        },
      },
    });
  });

  it("requires channel-specific activity to confirm JOIN", () => {
    const [welcome] = parseTwitchIrcFrame(":tmi.twitch.tv 001 guest :Welcome\r\n");
    const [room] = parseTwitchIrcFrame(roomState());
    expect(welcome).toMatchObject({ kind: "activity", confirmsJoin: false });
    expect(room).toMatchObject({
      kind: "activity",
      channel: "azumagbanjo",
      confirmsJoin: true,
    });
  });

  it("maps CLEARMSG/CLEARCHAT and PING/RECONNECT", () => {
    const events = parseTwitchIrcFrame(
      [
        "PING :tmi.twitch.tv",
        "@target-msg-id=m1;tmi-sent-ts=1788998401000 :tmi.twitch.tv CLEARMSG #azumagbanjo :old",
        "@target-user-id=u1;tmi-sent-ts=1788998402000 :tmi.twitch.tv CLEARCHAT #azumagbanjo :viewer",
        "@tmi-sent-ts=1788998403000 :tmi.twitch.tv CLEARCHAT #azumagbanjo",
        ":tmi.twitch.tv RECONNECT",
      ].join("\r\n"),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "ping",
      "delivery",
      "delivery",
      "delivery",
      "reconnect",
    ]);
    expect(events[1]).toMatchObject({
      delivery: { mutation: { kind: "delete", id: "m1" } },
    });
    expect(events[2]).toMatchObject({
      delivery: { mutation: { kind: "clear-user", authorId: "u1" } },
    });
    expect(events[3]).toMatchObject({
      delivery: { mutation: { kind: "clear" } },
    });
  });

  it("preserves the legacy EventSub namespace for the same configured channel", () => {
    const state = createStoppedState(time).twitch;
    state.channel = "azumagbanjo";
    state.broadcasterId = "123456";
    expect(twitchSourceNamespace(state, "azumagbanjo")).toBe("123456");
    expect(twitchSourceNamespace(state, "other_channel")).toBe("other_channel");
  });
});

describe("anonymous IRC relay lifecycle", () => {
  it("connects without Twitch secrets, answers PING and enqueues IRC chat", async () => {
    const { relay, flushWaits } = fixture();
    const socket = await startConnected(relay, flushWaits);
    socket.message("PING :tmi.twitch.tv\r\n");
    expect(socket.sent.at(-1)).toBe("PONG :tmi.twitch.tv");
    socket.message(
      `@display-name=視聴者;id=m1;user-id=u1;tmi-sent-ts=${millis} :viewer!viewer@viewer.tmi.twitch.tv PRIVMSG #azumagbanjo :IRC message\r\n`,
    );
    await flushWaits();
    const delta = await relay.commentsDeltaSimple(50);
    expect(delta.events).toHaveLength(1);
    expect(delta.events[0]).toMatchObject({
      id: "twitch:azumagbanjo:m1",
      type: "upsert",
      message: "IRC message",
    });
  });

  it("keeps the durable queue/R2 flush path and deduplicates duplicate IRC frames", async () => {
    const { relay, objects, storage, flushWaits } = fixture();
    await startConnected(relay, flushWaits);
    const event = delivery("channel.chat.message", {
      id: "m1",
      mutation: {
        kind: "message",
        id: "m1",
        authorId: "u1",
        name: "viewer",
        message: "hello",
      },
    });
    await relay.receiveTwitch(event);
    await relay.receiveTwitch(event);
    expect((await relay.commentsDeltaSimple(50)).events).toHaveLength(1);
    expect(await storage.getAlarm()).toBe(millis + 15_000);
    vi.advanceTimersByTime(15_000);
    await relay.alarm();
    expect(JSON.parse(objects.get("comments.json")!)).toEqual([
      { name: "viewer", message: "hello", created_at: time },
    ]);
    expect(await storage.getAlarm()).toBe(millis + 75_000);
  });

  it("serializes JOIN state behind an in-flight R2 write", async () => {
    const { relay, put, flushWaits } = fixture();
    let release!: () => void;
    let entered!: () => void;
    const inR2 = new Promise<void>((resolve) => {
      entered = resolve;
    });
    put.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {};
    });

    const start = relay.startTwitch();
    await inR2;
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.message(roomState());

    // The callback queued a serialized state transition; it must not write relay_state
    // while startTwitch still owns the R2 operation.
    release();
    await start;
    await flushWaits();
    expect((await relay.status()).twitch.phase).toBe("running");
  });

  it("does not let reconnect scheduling delay an earlier YouTube alarm", async () => {
    const { relay, storage, flushWaits } = fixture();
    const socket = await startConnected(relay, flushWaits);
    const state = loadRelayState(storage);
    saveRelayState(storage, {
      ...state,
      enabled: true,
      nextActionAt: new Date(millis + 500).toISOString(),
    });

    socket.error();
    await flushWaits();
    expect(loadRelayState(storage).twitch.reconnectAt).toBe(
      new Date(millis + 1000).toISOString(),
    );
    expect(await storage.getAlarm()).toBe(millis + 500);
  });

  it("reconnects after Twitch RECONNECT and remains enabled across YouTube stop", async () => {
    const { relay, flushWaits } = fixture();
    const first = await startConnected(relay, flushWaits);
    first.message(":tmi.twitch.tv RECONNECT\r\n");
    await flushWaits();
    expect((await relay.status()).twitch.phase).toBe("error");
    await relay.alarm();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.latest();
    second.open();
    second.message(":tmi.twitch.tv 001 guest :Welcome\r\n");
    await flushWaits();
    expect((await relay.status()).twitch.phase).toBe("waiting");
    second.message(roomState());
    await flushWaits();
    expect((await relay.status()).twitch.phase).toBe("running");
    await relay.start("@example");
    await relay.stop();
    expect((await relay.status()).twitch.enabled).toBe(true);
  });

  it("keeps the legacy numeric namespace so IRC moderation reaches existing comments", async () => {
    const { relay, storage, flushWaits } = fixture();
    const state = loadRelayState(storage);
    const legacy: TwitchDelivery = {
      ...delivery("channel.chat.message"),
      id: "legacy-message",
      broadcasterId: "123456",
      mutation: {
        kind: "message",
        id: "legacy-message",
        authorId: "legacy-viewer",
        name: "legacy viewer",
        message: "legacy EventSub comment",
      },
    };
    applyTwitchDelivery(storage, state.runId, legacy);
    saveRelayState(storage, {
      ...state,
      twitch: {
        ...state.twitch,
        enabled: true,
        channel: "azumagbanjo",
        broadcasterId: "123456",
        phase: "running",
        startedAt: time,
      },
    });

    await relay.startTwitch();
    const socket = FakeWebSocket.latest();
    socket.open();
    socket.message(roomState());
    await flushWaits();
    expect((await relay.status()).twitch.broadcasterId).toBe("123456");

    socket.message(
      `@target-msg-id=legacy-message;tmi-sent-ts=${millis + 1000} :tmi.twitch.tv CLEARMSG #azumagbanjo :old\r\n`,
    );
    await flushWaits();
    await relay.commentsDeltaSimple(50);
    expect(listComments(storage, state.runId)).toEqual([]);
  });

  it("stops the socket and ignores queued events from before the next start", async () => {
    const { relay, flushWaits } = fixture();
    const socket = await startConnected(relay, flushWaits);
    const old = delivery();
    await relay.stopTwitch();
    expect(socket.readyState).toBe(3);
    await relay.receiveTwitch(old);
    expect((await relay.commentsDeltaSimple(50)).events).toHaveLength(0);
    vi.advanceTimersByTime(5000);
    await relay.startTwitch();
    await relay.receiveTwitch(old);
    expect((await relay.commentsDeltaSimple(50)).events).toHaveLength(0);
  });

  it("protects Twitch controls and removes the old public EventSub endpoint", async () => {
    const { env } = fixture();
    const unauthorized = await worker.fetch(
      new Request("https://relay.example/api/twitch/start", { method: "POST" }),
      env,
    );
    expect(unauthorized.status).toBe(401);
    const oldWebhook = await worker.fetch(
      new Request("https://relay.example/api/twitch/eventsub", { method: "POST" }),
      env,
    );
    expect(oldWebhook.status).toBe(404);
  });

  it("selects Twitch watchdog independently from the YouTube alarm", () => {
    const running = createRunningState("@example", time);
    running.nextActionAt = "2026-09-10T00:05:00Z";
    running.twitch.enabled = true;
    expect(nextRelayAlarm(running)).toBe(millis + 60_000);
    running.twitch.flushAt = "2026-09-10T00:00:15Z";
    expect(nextRelayAlarm(running)).toBe(millis + 15_000);
  });

  it("still migrates a pre-Twitch relay state", () => {
    const { storage } = fixture();
    const state = createStoppedState();
    const { twitch: _, ...old } = state;
    storage.sql.exec(
      "UPDATE relay_state SET data = ? WHERE id = 1",
      JSON.stringify(old),
    );
    expect(loadRelayState(storage).twitch.enabled).toBe(false);
  });
});

describe("Twitch moderation and ordering", () => {
  it("merges platforms and clears only Twitch", () => {
    const { storage } = fixture();
    initializeRelayStorage(storage);
    applyChatItems(storage, "run", [
      {
        id: "yt",
        snippet: { publishedAt: time, displayMessage: "YouTube" },
        authorDetails: { displayName: "viewer", channelId: "viewer1" },
      },
    ]);
    applyTwitchDelivery(storage, "run", delivery());
    applyTwitchDelivery(
      storage,
      "run",
      delivery("channel.chat.clear", { mutation: { kind: "clear" } }),
    );
    applyTwitchDelivery(storage, "run", delivery());
    expect(listComments(storage, "run").map((comment) => comment.message)).toEqual([
      "YouTube",
    ]);
    expect(
      getCommentDelta(storage, "run", "run", 0, 50).events.map(
        (event) => event.type,
      ),
    ).toEqual(["upsert", "upsert", "delete"]);
  });

  it("handles deletion before arrival and preserves messages newer than a clear", () => {
    const { storage } = fixture();
    applyTwitchDelivery(
      storage,
      "run",
      delivery("channel.chat.message_delete", {
        mutation: { kind: "delete", id: "msg1" },
      }),
    );
    applyTwitchDelivery(storage, "run", delivery());
    expect(listComments(storage, "run")).toEqual([]);

    const fresh = delivery("channel.chat.message", {
      mutation: {
        kind: "message",
        id: "msg2",
        authorId: "viewer1",
        name: "v",
        message: "new",
      },
      timestamp: "2026-09-10T00:00:05Z",
    });
    applyTwitchDelivery(storage, "run", fresh);
    applyTwitchDelivery(
      storage,
      "run",
      delivery("channel.chat.clear_user_messages", {
        mutation: { kind: "clear-user", authorId: "viewer1" },
      }),
    );
    expect(listComments(storage, "run")).toHaveLength(1);
    applyTwitchDelivery(
      storage,
      "run",
      delivery("channel.chat.clear_user_messages", {
        mutation: { kind: "clear-user", authorId: "viewer1" },
        timestamp: "2026-09-10T00:00:10Z",
      }),
    );
    applyTwitchDelivery(storage, "run", fresh);
    expect(listComments(storage, "run")).toEqual([]);
  });
});

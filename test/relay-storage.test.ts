import { afterEach, describe, expect, it } from "vitest";
import {
  applyChatItems,
  getCommentDelta,
  initializeRelayStorage,
  listComments,
} from "../src/relay-storage";
import type { LiveChatMessageItem } from "../src/youtube";

interface StatementLike {
  all(...bindings: unknown[]): Array<Record<string, unknown>>;
}

interface DatabaseLike {
  exec(query: string): void;
  prepare(query: string): StatementLike;
  close(): void;
}

const nodeRuntime = globalThis as typeof globalThis & {
  process: {
    getBuiltinModule(specifier: string): unknown;
  };
};

const { DatabaseSync } = nodeRuntime.process.getBuiltinModule("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseLike;
};

const openDatabases: DatabaseLike[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
});

describe("comment delta storage", () => {
  it("同一時刻の新着をseq順で返し、同じYouTubeページの再適用では増殖しない", () => {
    const storage = createStorage();
    const items = [
      comment("comment-1", "viewer-1", "one"),
      comment("comment-2", "viewer-2", "two"),
    ];

    expect(applyChatItems(storage, "run-1", items)).toEqual({
      changed: true,
      ended: false,
    });
    const first = getCommentDelta(storage, "run-1", "run-1", 0, 50);
    expect(first.events.map((event) => [event.seq, event.id])).toEqual([
      [1, "comment-1"],
      [2, "comment-2"],
    ]);
    expect(first.nextCursor).toBe(2);
    expect(first.hasMore).toBe(false);

    expect(applyChatItems(storage, "run-1", items)).toEqual({
      changed: false,
      ended: false,
    });
    expect(getCommentDelta(storage, "run-1", "run-1", 0, 50)).toEqual(
      first,
    );
  });

  it("更新と削除を追記イベントとして返す", () => {
    const storage = createStorage();
    applyChatItems(storage, "run-1", [
      comment("comment-1", "viewer-1", "before"),
    ]);
    applyChatItems(storage, "run-1", [
      comment("comment-1", "viewer-1", "after"),
    ]);
    applyChatItems(
      storage,
      "run-1",
      [deletedMessage("comment-1")],
      () => "2026-08-27T00:00:10.000Z",
    );

    const delta = getCommentDelta(storage, "run-1", "run-1", 0, 50);
    expect(delta.events).toEqual([
      {
        seq: 1,
        type: "upsert",
        id: "comment-1",
        name: "viewer-1",
        message: "before",
        created_at: "2026-08-27T00:00:00.000Z",
      },
      {
        seq: 2,
        type: "upsert",
        id: "comment-1",
        name: "viewer-1",
        message: "after",
        created_at: "2026-08-27T00:00:00.000Z",
      },
      {
        seq: 3,
        type: "delete",
        id: "comment-1",
        name: null,
        message: null,
        created_at: "2026-08-27T00:00:10.000Z",
      },
    ]);
    expect(listComments(storage, "run-1")).toEqual([]);
  });

  it("投稿者BANでは、その投稿者の各コメントを削除イベントにする", () => {
    const storage = createStorage();
    applyChatItems(storage, "run-1", [
      comment("comment-1", "viewer-1", "one"),
      comment("comment-2", "viewer-1", "two"),
      comment("comment-3", "viewer-2", "three"),
    ]);
    applyChatItems(storage, "run-1", [bannedAuthor("viewer-1")]);

    const delta = getCommentDelta(storage, "run-1", "run-1", 3, 50);
    expect(delta.events.map((event) => [event.type, event.id])).toEqual([
      ["delete", "comment-1"],
      ["delete", "comment-2"],
    ]);
    expect(listComments(storage, "run-1")).toEqual([
      {
        name: "viewer-2",
        message: "three",
        created_at: "2026-08-27T00:00:00.000Z",
      },
    ]);
  });

  it("limit単位でページングし、同じカーソルは同じページを返す", () => {
    const storage = createStorage();
    applyChatItems(storage, "run-1", [
      comment("comment-1", "viewer-1", "one"),
      comment("comment-2", "viewer-2", "two"),
      comment("comment-3", "viewer-3", "three"),
      comment("comment-4", "viewer-4", "four"),
      comment("comment-5", "viewer-5", "five"),
    ]);

    const first = getCommentDelta(storage, "run-1", "run-1", 0, 2);
    expect(first.events.map((event) => event.id)).toEqual([
      "comment-1",
      "comment-2",
    ]);
    expect(first.nextCursor).toBe(2);
    expect(first.hasMore).toBe(true);
    expect(getCommentDelta(storage, "run-1", "run-1", 0, 2)).toEqual(
      first,
    );

    const second = getCommentDelta(
      storage,
      "run-1",
      "run-1",
      first.nextCursor,
      2,
    );
    expect(second.events.map((event) => event.id)).toEqual([
      "comment-3",
      "comment-4",
    ]);
    expect(second.nextCursor).toBe(4);
    expect(second.hasMore).toBe(true);

    const third = getCommentDelta(
      storage,
      "run-1",
      "run-1",
      second.nextCursor,
      2,
    );
    expect(third.events.map((event) => event.id)).toEqual(["comment-5"]);
    expect(third.nextCursor).toBe(5);
    expect(third.hasMore).toBe(false);
  });

  it("初回は現在位置だけを返し、stream切替時は履歴を大量再生しない", () => {
    const storage = createStorage();
    applyChatItems(storage, "run-1", [
      comment("old-comment", "viewer-1", "old"),
    ]);
    applyChatItems(storage, "run-2", [
      comment("new-comment", "viewer-2", "new"),
    ]);

    expect(getCommentDelta(storage, "run-2", null, null, 50)).toEqual({
      streamId: "run-2",
      events: [],
      nextCursor: 2,
      hasMore: false,
      reset: false,
    });
    expect(getCommentDelta(storage, "run-2", "run-1", 1, 50)).toEqual({
      streamId: "run-2",
      events: [],
      nextCursor: 2,
      hasMore: false,
      reset: true,
    });

    applyChatItems(storage, "run-2", [
      comment("later-comment", "viewer-3", "later"),
    ]);
    const resumed = getCommentDelta(storage, "run-2", "run-2", 2, 50);
    expect(resumed.events.map((event) => event.id)).toEqual([
      "later-comment",
    ]);
    expect(resumed.nextCursor).toBe(3);
  });

  it("現在末尾より先のカーソルは現在位置へリセットする", () => {
    const storage = createStorage();
    applyChatItems(storage, "run-1", [
      comment("comment-1", "viewer-1", "one"),
    ]);

    expect(getCommentDelta(storage, "run-1", "run-1", 999, 50)).toEqual({
      streamId: "run-1",
      events: [],
      nextCursor: 1,
      hasMore: false,
      reset: true,
    });
  });
});

function createStorage(): DurableObjectStorage {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);

  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const statementCount = query
          .split(";")
          .map((part) => part.trim())
          .filter((part) => part !== "").length;
        if (bindings.length === 0 && statementCount > 1) {
          database.exec(query);
          return { toArray: () => [] };
        }

        const rows = database.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
  };

  const durableStorage = storage as unknown as DurableObjectStorage;
  initializeRelayStorage(durableStorage);
  return durableStorage;
}

function comment(
  id: string,
  authorChannelId: string,
  message: string,
): LiveChatMessageItem {
  return {
    id,
    snippet: {
      type: "textMessageEvent",
      publishedAt: "2026-08-27T00:00:00.000Z",
      hasDisplayContent: true,
      displayMessage: message,
    },
    authorDetails: {
      channelId: authorChannelId,
      displayName: authorChannelId,
    },
  };
}

function deletedMessage(id: string): LiveChatMessageItem {
  return {
    id: `delete-${id}`,
    snippet: {
      type: "messageDeletedEvent",
      messageDeletedDetails: { deletedMessageId: id },
    },
  };
}

function bannedAuthor(authorChannelId: string): LiveChatMessageItem {
  return {
    id: `ban-${authorChannelId}`,
    snippet: {
      type: "userBannedEvent",
      publishedAt: "2026-08-27T00:00:20.000Z",
      userBannedDetails: {
        bannedUserDetails: { channelId: authorChannelId },
      },
    },
  };
}

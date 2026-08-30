import {
  createStoppedState,
  type CommentDeltaEvent,
  type CommentDeltaEventType,
  type CommentDeltaResponse,
  type ExportedComment,
  type RelayState,
  type SimpleCommentDeltaResponse,
  type StoredComment,
} from "./types";
import {
  classifyLiveChatItem,
  normalizeDateTime,
  type LiveChatMessageItem,
} from "./youtube";

interface StateRow {
  [key: string]: SqlStorageValue;
  data: string;
}

interface CommentRow {
  [key: string]: SqlStorageValue;
  name: string;
  message: string;
  created_at: string;
}

interface StoredCommentRow extends CommentRow {
  id: string;
  author_channel_id: string | null;
}

interface CommentEventRow {
  [key: string]: SqlStorageValue;
  seq: number;
  type: string;
  comment_id: string;
  name: string | null;
  message: string | null;
  created_at: string;
}

interface CursorRow {
  [key: string]: SqlStorageValue;
  cursor: number;
}

export interface MutationResult {
  changed: boolean;
  ended: boolean;
}

export function initializeRelayStorage(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS relay_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS comments (
      run_id TEXT NOT NULL,
      id TEXT NOT NULL,
      author_channel_id TEXT,
      name TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, id)
    );

    CREATE INDEX IF NOT EXISTS comments_run_created_at
      ON comments (run_id, created_at, id);

    CREATE INDEX IF NOT EXISTS comments_run_author
      ON comments (run_id, author_channel_id);

    CREATE TABLE IF NOT EXISTS comment_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('upsert', 'delete')),
      comment_id TEXT NOT NULL,
      name TEXT,
      message TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS comment_events_run_seq
      ON comment_events (run_id, seq);
  `);

  const existing = storage.sql
    .exec<StateRow>("SELECT data FROM relay_state WHERE id = 1")
    .toArray()[0];
  if (existing === undefined) {
    saveRelayState(storage, createStoppedState());
  }
}

export function applyChatItems(
  storage: DurableObjectStorage,
  runId: string,
  items: LiveChatMessageItem[],
  now: () => string = () => new Date().toISOString(),
): MutationResult {
  let changed = false;
  let ended = false;

  for (const item of items) {
    const mutation = classifyLiveChatItem(item);
    switch (mutation.kind) {
      case "upsert": {
        const existing = findStoredComment(
          storage,
          runId,
          mutation.comment.id,
        );
        if (existing !== undefined && commentsEqual(existing, mutation.comment)) {
          break;
        }

        storage.sql.exec(
          `INSERT INTO comments (
            run_id, id, author_channel_id, name, message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (run_id, id) DO UPDATE SET
            author_channel_id = excluded.author_channel_id,
            name = excluded.name,
            message = excluded.message,
            created_at = excluded.created_at`,
          runId,
          mutation.comment.id,
          mutation.comment.authorChannelId,
          mutation.comment.name,
          mutation.comment.message,
          mutation.comment.created_at,
        );
        appendCommentEvent(storage, runId, {
          type: "upsert",
          id: mutation.comment.id,
          name: mutation.comment.name,
          message: mutation.comment.message,
          created_at: mutation.comment.created_at,
        });
        changed = true;
        break;
      }
      case "delete-message": {
        const existing = findStoredComment(storage, runId, mutation.messageId);
        if (existing === undefined) {
          break;
        }

        storage.sql.exec(
          "DELETE FROM comments WHERE run_id = ? AND id = ?",
          runId,
          mutation.messageId,
        );
        appendCommentEvent(storage, runId, {
          type: "delete",
          id: mutation.messageId,
          name: null,
          message: null,
          created_at: eventTimestamp(item, now),
        });
        changed = true;
        break;
      }
      case "delete-author": {
        const deleted = storage.sql
          .exec<StoredCommentRow>(
            `SELECT id, author_channel_id, name, message, created_at
             FROM comments
             WHERE run_id = ? AND author_channel_id = ?
             ORDER BY created_at ASC, id ASC`,
            runId,
            mutation.authorChannelId,
          )
          .toArray();
        if (deleted.length === 0) {
          break;
        }

        storage.sql.exec(
          "DELETE FROM comments WHERE run_id = ? AND author_channel_id = ?",
          runId,
          mutation.authorChannelId,
        );
        const createdAt = eventTimestamp(item, now);
        for (const comment of deleted) {
          appendCommentEvent(storage, runId, {
            type: "delete",
            id: comment.id,
            name: null,
            message: null,
            created_at: createdAt,
          });
        }
        changed = true;
        break;
      }
      case "ended":
        ended = true;
        break;
      case "ignore":
        break;
    }
  }

  return { changed, ended };
}

export function getCommentDelta(
  storage: DurableObjectStorage,
  currentRunId: string,
  clientStreamId: string | null,
  after: number | null,
  limit: number,
): CommentDeltaResponse {
  const tailCursor = getEventTailCursor(storage, currentRunId);
  const streamChanged =
    clientStreamId !== null && clientStreamId !== currentRunId;
  const cursorInvalid = after !== null && (after < 0 || after > tailCursor);

  if (after === null || streamChanged || cursorInvalid) {
    return {
      streamId: currentRunId,
      events: [],
      nextCursor: tailCursor,
      hasMore: false,
      reset: streamChanged || cursorInvalid,
    };
  }

  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = storage.sql
    .exec<CommentEventRow>(
      `SELECT seq, type, comment_id, name, message, created_at
       FROM comment_events
       WHERE run_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
      currentRunId,
      after,
      safeLimit + 1,
    )
    .toArray();
  const hasMore = rows.length > safeLimit;
  const page = rows.slice(0, safeLimit).map(toCommentDeltaEvent);

  return {
    streamId: currentRunId,
    events: page,
    nextCursor: page.at(-1)?.seq ?? after,
    hasMore,
    reset: false,
  };
}

export function getSimpleCommentDelta(
  storage: DurableObjectStorage,
  currentRunId: string,
  limit: number,
): SimpleCommentDeltaResponse {
  const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  const rows = storage.sql
    .exec<CommentEventRow>(
      `SELECT seq, type, comment_id, name, message, created_at
       FROM comment_events
       WHERE run_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
      currentRunId,
      safeLimit + 1,
    )
    .toArray();
  const truncated = rows.length > safeLimit;
  const events = rows
    .slice(0, safeLimit)
    .reverse()
    .map(toCommentDeltaEvent);
  const latestCursor = events.at(-1)?.seq ?? 0;

  return {
    streamId: currentRunId,
    events,
    windowStartCursor: events[0]?.seq ?? latestCursor,
    latestCursor,
    truncated,
    windowSize: safeLimit,
  };
}

export function listComments(
  storage: DurableObjectStorage,
  runId: string,
): ExportedComment[] {
  return storage.sql
    .exec<CommentRow>(
      `SELECT name, message, created_at
       FROM comments
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
      runId,
    )
    .toArray()
    .map((row) => ({
      name: row.name,
      message: row.message,
      created_at: row.created_at,
    }));
}

export function countComments(
  storage: DurableObjectStorage,
  runId: string,
): number {
  const row = storage.sql
    .exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM comments WHERE run_id = ?",
      runId,
    )
    .toArray()[0];
  return row?.count ?? 0;
}

export function deleteRunComments(
  storage: DurableObjectStorage,
  runId: string,
): void {
  storage.sql.exec("DELETE FROM comments WHERE run_id = ?", runId);
}

export function deleteRunEvents(
  storage: DurableObjectStorage,
  runId: string,
): void {
  storage.sql.exec("DELETE FROM comment_events WHERE run_id = ?", runId);
}

export function loadRelayState(
  storage: DurableObjectStorage,
  onParseError?: (error: unknown) => void,
): RelayState {
  const row = storage.sql
    .exec<StateRow>("SELECT data FROM relay_state WHERE id = 1")
    .toArray()[0];
  if (row === undefined) {
    const state = createStoppedState();
    saveRelayState(storage, state);
    return state;
  }

  try {
    const parsed = JSON.parse(row.data) as Partial<RelayState>;
    const fallback = createStoppedState(
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
    );
    return {
      ...fallback,
      ...parsed,
      version: 1,
      runId:
        typeof parsed.runId === "string" && parsed.runId !== ""
          ? parsed.runId
          : fallback.runId,
    };
  } catch (error) {
    onParseError?.(error);
    const state = createStoppedState();
    saveRelayState(storage, state);
    return state;
  }
}

export function saveRelayState(
  storage: DurableObjectStorage,
  state: RelayState,
): void {
  storage.sql.exec(
    `INSERT INTO relay_state (id, data) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data`,
    JSON.stringify(state),
  );
}

function findStoredComment(
  storage: DurableObjectStorage,
  runId: string,
  commentId: string,
): StoredCommentRow | undefined {
  return storage.sql
    .exec<StoredCommentRow>(
      `SELECT id, author_channel_id, name, message, created_at
       FROM comments
       WHERE run_id = ? AND id = ?`,
      runId,
      commentId,
    )
    .toArray()[0];
}

function commentsEqual(
  existing: StoredCommentRow,
  incoming: StoredComment,
): boolean {
  return (
    existing.author_channel_id === incoming.authorChannelId &&
    existing.name === incoming.name &&
    existing.message === incoming.message &&
    existing.created_at === incoming.created_at
  );
}

function appendCommentEvent(
  storage: DurableObjectStorage,
  runId: string,
  event: Omit<CommentDeltaEvent, "seq">,
): void {
  storage.sql.exec(
    `INSERT INTO comment_events (
      run_id, type, comment_id, name, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    runId,
    event.type,
    event.id,
    event.name,
    event.message,
    event.created_at,
  );
}

function getEventTailCursor(
  storage: DurableObjectStorage,
  runId: string,
): number {
  const row = storage.sql
    .exec<CursorRow>(
      `SELECT COALESCE(MAX(seq), 0) AS cursor
       FROM comment_events
       WHERE run_id = ?`,
      runId,
    )
    .toArray()[0];
  return row?.cursor ?? 0;
}

function toCommentDeltaEvent(row: CommentEventRow): CommentDeltaEvent {
  return {
    seq: row.seq,
    type: normalizeEventType(row.type),
    id: row.comment_id,
    name: row.name,
    message: row.message,
    created_at: row.created_at,
  };
}

function normalizeEventType(value: string): CommentDeltaEventType {
  return value === "delete" ? "delete" : "upsert";
}

function eventTimestamp(
  item: LiveChatMessageItem,
  now: () => string,
): string {
  return normalizeDateTime(item.snippet?.publishedAt) ?? now();
}

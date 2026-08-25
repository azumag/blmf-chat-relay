import {
  createStoppedState,
  type ExportedComment,
  type RelayState,
} from "./types";
import {
  classifyLiveChatItem,
  type LiveChatMessageItem,
} from "./youtube";

interface StateRow {
  data: string;
}

interface CommentRow {
  name: string;
  message: string;
  created_at: string;
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
): MutationResult {
  let changed = false;
  let ended = false;

  for (const item of items) {
    const mutation = classifyLiveChatItem(item);
    switch (mutation.kind) {
      case "upsert":
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
        changed = true;
        break;
      case "delete-message":
        storage.sql.exec(
          "DELETE FROM comments WHERE run_id = ? AND id = ?",
          runId,
          mutation.messageId,
        );
        changed = true;
        break;
      case "delete-author":
        storage.sql.exec(
          "DELETE FROM comments WHERE run_id = ? AND author_channel_id = ?",
          runId,
          mutation.authorChannelId,
        );
        changed = true;
        break;
      case "ended":
        ended = true;
        break;
      case "ignore":
        break;
    }
  }

  return { changed, ended };
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

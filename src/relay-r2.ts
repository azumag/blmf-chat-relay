import {
  archiveObjectKey,
  readRelayConfig,
  toRelayStatus,
  type ExportedComment,
  type RelayState,
} from "./types";

const JSON_METADATA = {
  contentType: "application/json; charset=utf-8",
  cacheControl: "no-store, max-age=0, must-revalidate",
} as const;

export async function flushRelaySnapshot(
  env: Env,
  state: RelayState,
  comments: ExportedComment[],
): Promise<RelayState> {
  const config = readRelayConfig(env);
  const flushedAt = new Date().toISOString();
  const snapshotState: RelayState = {
    ...state,
    lastFlushAt: flushedAt,
    updatedAt: flushedAt,
    lastError: state.lastError?.startsWith("R2:")
      ? null
      : state.lastError,
    nextActionAt: state.enabled ? state.nextActionAt : null,
  };
  const status = toRelayStatus(snapshotState, comments.length, config);
  const commentsJson = JSON.stringify(comments);
  const statusJson = JSON.stringify(status, null, 2);

  const commentWrites: Array<Promise<R2Object | null>> = [
    env.COMMENTS_BUCKET.put(config.currentObjectKey, commentsJson, {
      httpMetadata: JSON_METADATA,
    }),
  ];

  const archiveKey = archiveObjectKey(snapshotState);
  if (archiveKey !== null) {
    commentWrites.push(
      env.COMMENTS_BUCKET.put(archiveKey, commentsJson, {
        httpMetadata: JSON_METADATA,
      }),
    );
  }

  await Promise.all(commentWrites);
  await env.COMMENTS_BUCKET.put(config.statusObjectKey, statusJson, {
    httpMetadata: JSON_METADATA,
  });
  return snapshotState;
}

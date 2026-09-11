import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// Real workerd/Miniflare smoke test. Twitch IRC itself is covered with a deterministic
// WebSocket fake in Vitest; this test deliberately avoids external network dependency.
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{
    name: "relay-test",
    modules: true,
    scriptPath: ".wrangler/test-bundle/index.js",
    compatibilityDate: "2026-08-25",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CHAT_RELAY: { className: "YouTubeChatRelay", useSQLite: true } },
    r2Buckets: ["COMMENTS_BUCKET"],
    bindings: {
      DEFAULT_TWITCH_CHANNEL: "azumagbanjo",
      ADMIN_TOKEN: "runtime-admin",
      YOUTUBE_API_KEY: "unused",
      DEFAULT_YOUTUBE_CHANNEL: "",
      R2_CURRENT_OBJECT_KEY: "comments.json",
      R2_STATUS_OBJECT_KEY: "status.json",
      R2_FLUSH_INTERVAL_SECONDS: "5",
      PUBLIC_R2_BASE_URL: "https://chat.blmf.bluemoon.works",
      DISCOVERY_INTERVAL_SECONDS: "300",
    },
  }],
}));

const request = (path, options) => mf.dispatchFetch(`http://localhost${path}`, options);

try {
  const health = await request("/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "blmf-chat-relay");

  const status = await request("/api/status");
  assert.equal(status.status, 200);
  assert.equal((await status.json()).twitch.phase, "stopped");

  const unauthorized = await request("/api/twitch/start", { method: "POST" });
  assert.equal(unauthorized.status, 401);

  // EventSub is intentionally gone; no public Twitch callback remains.
  const oldWebhook = await request("/api/twitch/eventsub", { method: "POST" });
  assert.equal(oldWebhook.status, 404);

  const bucket = await mf.getR2Bucket("COMMENTS_BUCKET");
  await bucket.put("comments.json", JSON.stringify([
    { name: "sample", message: "fallback", created_at: "2026-01-01T00:00:00.000Z" },
  ]));
  const delta = await (await request("/api/comments/delta/simple")).json();
  assert.equal(delta.events[0]?.message, "fallback");

  console.log("PASS: real Worker routes/status/R2 fallback; EventSub endpoint removed");
  if (process.argv.includes("--preview")) {
    console.log(`Local UI preview (2 minutes): ${await mf.ready}`);
    await new Promise((resolve) => setTimeout(resolve, 120_000));
  }
} finally {
  await mf.dispose();
}

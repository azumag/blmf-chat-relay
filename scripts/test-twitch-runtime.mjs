import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

// The actual workerd runtime with local-only storage and synthetic EventSub data.
const secret = "runtime-test-only-secret";
const types = ["channel.chat.message", "channel.chat.message_delete", "channel.chat.clear_user_messages", "channel.chat.clear"];
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: "relay-test",
  modules: true, scriptPath: ".wrangler/test-bundle/index.js",
  compatibilityDate: "2026-08-25", compatibilityFlags: ["nodejs_compat"],
  durableObjects: { CHAT_RELAY: { className: "YouTubeChatRelay", useSQLite: true } },
  r2Buckets: ["COMMENTS_BUCKET"],
  bindings: {
    DEFAULT_TWITCH_CHANNEL: "azumagbanjo", TWITCH_BROADCASTER_ID: "123", TWITCH_EVENTSUB_SECRET: secret,
    ADMIN_TOKEN: "runtime-admin", YOUTUBE_API_KEY: "unused", DEFAULT_YOUTUBE_CHANNEL: "",
    R2_CURRENT_OBJECT_KEY: "comments.json", R2_STATUS_OBJECT_KEY: "status.json", R2_FLUSH_INTERVAL_SECONDS: "5",
    PUBLIC_R2_BASE_URL: "https://chat.blmf.bluemoon.works", DISCOVERY_INTERVAL_SECONDS: "300",
  },
  }],
}));
const request = (path, options) => mf.dispatchFetch(`http://localhost${path}`, options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function send(type, event, kind = "notification", messageId = randomUUID()) {
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({ subscription: { id: type, type, version: "1", status: kind === "webhook_callback_verification" ? "webhook_callback_verification_pending" : "enabled",
    condition: { broadcaster_user_id: "123" } },
    ...(kind === "webhook_callback_verification" ? { challenge: "test-challenge" } : { event: { broadcaster_user_id: "123", broadcaster_user_login: "azumagbanjo", ...event } }),
  });
  const signature = "sha256=" + createHmac("sha256", secret).update(messageId + timestamp + body).digest("hex");
  const response = await request("/api/twitch/eventsub", { method: "POST", body, headers: {
    "Twitch-Eventsub-Message-Id": messageId, "Twitch-Eventsub-Message-Timestamp": timestamp,
    "Twitch-Eventsub-Message-Type": kind, "Twitch-Eventsub-Message-Signature": signature,
    "Twitch-Eventsub-Subscription-Type": type, "Twitch-Eventsub-Subscription-Version": "1",
  } });
  assert.equal(response.status, kind === "notification" ? 204 : 200, await response.text());
}
try {
  for (const type of types) await send(type, null, "webhook_callback_verification");
  const start = await request("/api/twitch/start", { method: "POST", headers: { Authorization: "Bearer runtime-admin" } });
  assert.equal(start.status, 200);
  assert.equal((await start.json()).twitch.phase, "running");
  const event = { message_id: "test-message", chatter_user_id: "viewer", chatter_user_name: "テスト視聴者", message: { text: "ローカル検証" } };
  const receipt = randomUUID();
  await send("channel.chat.message", event, "notification", receipt);
  await send("channel.chat.message", event, "notification", receipt);
  const delta = await (await request("/api/comments/delta/simple")).json();
  assert.equal(delta.events.length, 1);
  assert.equal(delta.events[0].id, "twitch:123:test-message");
  const bucket = await mf.getR2Bucket("COMMENTS_BUCKET");
  let comments = [];
  for (let i = 0; i < 30; i++) {
    comments = await (await bucket.get("comments.json")).json();
    if (comments.length) break;
    await sleep(250);
  }
  assert.equal(comments[0]?.message, "ローカル検証", "single notification must reach R2 through a real alarm");
  await send("channel.chat.message_delete", { message_id: "test-message" });
  const deleted = await (await request("/api/comments/delta/simple")).json();
  assert.equal(deleted.events.at(-1).type, "delete");
  const stop = await request("/api/twitch/stop", { method: "POST", headers: { Authorization: "Bearer runtime-admin" } });
  assert.equal(stop.status, 200);
  assert.deepEqual(await (await bucket.get("comments.json")).json(), []);
  console.log("PASS: real Worker webhook → durable queue → SQLite delta → alarm → local R2; duplicate, deletion, stop");
  if (process.argv.includes("--preview")) {
    console.log(`Local UI preview (2 minutes): ${await mf.ready}`);
    await sleep(120_000);
  }
} finally {
  await mf.dispose();
}

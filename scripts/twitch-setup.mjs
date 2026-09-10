// Operator-only setup. Never prints tokens, secrets, or raw API responses.
const types = ["channel.chat.message", "channel.chat.message_delete", "channel.chat.clear_user_messages", "channel.chat.clear"];
const mode = process.argv[2] ?? "inspect";
// Matches wrangler.jsonc's DEFAULT_TWITCH_CHANNEL default (docs/twitch.md step 3 keeps
// it as-is); set DEFAULT_TWITCH_CHANNEL locally if a fork changes that default.
const channel = process.env.DEFAULT_TWITCH_CHANNEL || "azumagbanjo";
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} を設定してください。`);
  return value;
};

async function run() {
  if (!["inspect", "subscribe"].includes(mode)) throw new Error("Usage: node scripts/twitch-setup.mjs [inspect|subscribe]");
  const headers = { "Client-Id": required("TWITCH_CLIENT_ID"), Authorization: `Bearer ${required("TWITCH_APP_ACCESS_TOKEN")}`, "Content-Type": "application/json" };
  async function api(path, init = {}) {
    const response = await fetch(`https://api.twitch.tv/helix/${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Twitch ${init.method ?? "GET"}: HTTP ${response.status}。認可・トークン種別・既存の購読を確認してください。`);
    return response.status === 204 ? null : response.json();
  }
  const users = await api(`users?login=${encodeURIComponent(channel)}`);
  const broadcaster = users.data?.[0];
  if (!broadcaster || broadcaster.login !== channel) throw new Error("Twitchチャンネルが見つかりません。");
  console.log(`チャンネル: ${broadcaster.login}\nTWITCH_BROADCASTER_ID=${broadcaster.id}`);
  if (mode === "inspect") return;
  if (required("TWITCH_BROADCASTER_ID") !== broadcaster.id) throw new Error("TWITCH_BROADCASTER_ID がチャンネルと一致しません。");
  const userId = required("TWITCH_CHAT_USER_ID");
  if (!/^\d+$/.test(userId)) throw new Error("TWITCH_CHAT_USER_ID は数値IDです。");
  const callback = new URL(required("TWITCH_CALLBACK_URL"));
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash ||
      (callback.port && callback.port !== "443") || callback.pathname !== "/api/twitch/eventsub") {
    throw new Error("TWITCH_CALLBACK_URL は https://<Workerのホスト>/api/twitch/eventsub を指定してください。");
  }
  const secret = required("TWITCH_EVENTSUB_SECRET");
  if (!/^[\x21-\x7e]{10,100}$/.test(secret)) throw new Error("EventSub secretは10〜100文字のASCIIで設定してください。");
  const subscriptions = [];
  let cursor;
  do {
    const page = await api(`eventsub/subscriptions${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`);
    subscriptions.push(...page.data);
    cursor = page.pagination?.cursor;
  } while (cursor);
  for (const type of types) {
    const existing = subscriptions.find((sub) => sub.type === type && sub.version === "1" &&
      sub.condition.broadcaster_user_id === broadcaster.id && sub.condition.user_id === userId &&
      sub.transport.method === "webhook" && sub.transport.callback === callback.href);
    if (existing) {
      console.log(`${type}: 既存 (${existing.status})。管理画面の接続状態も確認してください。`);
      continue;
    }
    const result = await api("eventsub/subscriptions", { method: "POST", body: JSON.stringify({
      type, version: "1", condition: { broadcaster_user_id: broadcaster.id, user_id: userId },
      transport: { method: "webhook", callback: callback.href, secret },
    }) });
    console.log(`${type}: ${result.data?.[0]?.status ?? "登録要求済み"}`);
  }
  console.log("管理画面でTwitchを開始し、接続状態と実際のコメント受信を確認してください。");
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });

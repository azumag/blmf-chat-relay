export const ADMIN_HTML = `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BLMF Chat Relay</title>
  <link rel="stylesheet" href="/admin.css">
  <script src="/admin.js" defer></script>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">BLUEMOON WORKS</p>
        <h1>YouTube コメントリレー</h1>
        <p class="lead">チャンネルだけを指定して、現在のライブ配信を自動検出します。</p>
      </div>
      <div id="phaseBadge" class="badge" data-phase="stopped">停止中</div>
    </header>

    <section class="panel controls" aria-labelledby="controlTitle">
      <div class="section-heading">
        <div>
          <p class="section-kicker">CONTROL</p>
          <h2 id="controlTitle">リレー操作</h2>
        </div>
        <button id="refreshButton" class="button button-ghost" type="button">更新</button>
      </div>

      <label class="field">
        <span>YouTube チャンネル</span>
        <input id="channelInput" type="text" placeholder="@handle または UC… / チャンネルURL" autocomplete="off">
        <small>配信IDは不要です。空欄の場合は Worker の既定チャンネルを使用します。</small>
      </label>

      <label class="field">
        <span>管理トークン</span>
        <input id="tokenInput" type="password" placeholder="ADMIN_TOKEN" autocomplete="current-password">
      </label>

      <label class="remember">
        <input id="rememberInput" type="checkbox">
        <span>このブラウザに管理トークンを保存</span>
      </label>

      <div class="actions">
        <button id="startButton" class="button button-primary" type="button">開始・再検出</button>
        <button id="stopButton" class="button button-danger" type="button">停止</button>
      </div>
      <p id="actionMessage" class="action-message" role="status" aria-live="polite"></p>
    </section>

    <section class="panel" aria-labelledby="statusTitle">
      <div class="section-heading">
        <div>
          <p class="section-kicker">STATUS</p>
          <h2 id="statusTitle">現在の状態</h2>
        </div>
        <span id="updatedAt" class="muted">未取得</span>
      </div>

      <dl class="status-grid">
        <div><dt>チャンネル</dt><dd id="channelStatus">—</dd></div>
        <div><dt>配信</dt><dd id="broadcastStatus">—</dd></div>
        <div><dt>コメント数</dt><dd id="commentCount">0</dd></div>
        <div><dt>次回処理</dt><dd id="nextActionAt">—</dd></div>
        <div><dt>最終取得</dt><dd id="lastPollAt">—</dd></div>
        <div><dt>最終R2反映</dt><dd id="lastFlushAt">—</dd></div>
      </dl>

      <div id="errorBox" class="error-box" hidden>
        <strong>直近のエラー</strong>
        <span id="errorText"></span>
      </div>

      <div class="links">
        <a id="commentsLink" href="#" target="_blank" rel="noreferrer">comments.json</a>
        <a id="statusLink" href="#" target="_blank" rel="noreferrer">status.json</a>
        <a id="archiveLink" href="#" target="_blank" rel="noreferrer" hidden>配信アーカイブ</a>
      </div>
    </section>

    <footer>
      <span>Worker が有効な間だけ YouTube API を呼び出します。</span>
      <a href="/health">health</a>
    </footer>
  </main>
</body>
</html>`;

export const ADMIN_CSS = `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #080b12;
  color: #f4f7fb;
  font-synthesis: none;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at 12% 0%, rgba(82, 120, 255, .22), transparent 34rem),
    radial-gradient(circle at 92% 8%, rgba(64, 220, 179, .13), transparent 28rem),
    #080b12;
}
button, input { font: inherit; }
a { color: #9fb9ff; }

.shell {
  width: min(920px, calc(100% - 32px));
  margin: 0 auto;
  padding: 56px 0 40px;
}

.hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 28px;
}
.eyebrow, .section-kicker {
  margin: 0 0 8px;
  color: #7e9cff;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .16em;
}
h1, h2 { margin: 0; letter-spacing: -.035em; }
h1 { font-size: clamp(34px, 6vw, 58px); line-height: .98; }
h2 { font-size: 24px; }
.lead { max-width: 620px; margin: 16px 0 0; color: #aab2c1; font-size: 17px; }

.badge {
  flex: none;
  padding: 9px 13px;
  border: 1px solid #343b49;
  border-radius: 999px;
  background: rgba(17, 22, 34, .76);
  color: #b8c0ce;
  font-size: 13px;
  font-weight: 800;
}
.badge[data-phase="running"] { border-color: #246f5c; color: #6fe0bd; background: #0e2c26; }
.badge[data-phase="discovering"], .badge[data-phase="waiting"] { border-color: #665618; color: #f0d060; background: #2d2710; }
.badge[data-phase="error"] { border-color: #753742; color: #ff98a7; background: #32151b; }

.panel {
  margin-top: 18px;
  padding: clamp(20px, 4vw, 32px);
  border: 1px solid rgba(151, 164, 190, .16);
  border-radius: 22px;
  background: rgba(14, 18, 28, .86);
  box-shadow: 0 24px 80px rgba(0, 0, 0, .25);
  backdrop-filter: blur(14px);
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

.field { display: grid; gap: 8px; margin-top: 18px; color: #dce2ed; font-weight: 700; }
.field input {
  width: 100%;
  border: 1px solid #30394a;
  border-radius: 12px;
  outline: none;
  background: #0a0e17;
  color: #fff;
  padding: 13px 14px;
  transition: border-color .15s, box-shadow .15s;
}
.field input:focus { border-color: #6c8cff; box-shadow: 0 0 0 3px rgba(108, 140, 255, .16); }
.field small { color: #7f8999; font-weight: 500; line-height: 1.55; }
.remember { display: flex; align-items: center; gap: 9px; margin-top: 14px; color: #929cab; font-size: 13px; }
.remember input { accent-color: #6c8cff; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
.button {
  border: 0;
  border-radius: 11px;
  padding: 11px 16px;
  color: #fff;
  font-weight: 800;
  cursor: pointer;
  transition: transform .12s, filter .12s, opacity .12s;
}
.button:hover { filter: brightness(1.08); transform: translateY(-1px); }
.button:disabled { cursor: wait; opacity: .5; transform: none; }
.button-primary { background: #5679ff; }
.button-danger { background: #823342; }
.button-ghost { border: 1px solid #30394a; background: #151a26; color: #c1c9d7; }
.action-message { min-height: 1.4em; margin: 14px 0 0; color: #9fb9ff; font-size: 14px; }

.status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  margin: 0;
  border: 1px solid #252c39;
  border-radius: 14px;
  background: #252c39;
}
.status-grid div { min-width: 0; padding: 17px; background: #0c111b; }
dt { color: #778294; font-size: 12px; font-weight: 700; }
dd { overflow-wrap: anywhere; margin: 7px 0 0; color: #edf1f7; font-size: 15px; font-weight: 700; }
.muted { color: #778294; font-size: 12px; }
.error-box {
  display: flex;
  gap: 10px;
  margin-top: 16px;
  padding: 13px 14px;
  border: 1px solid #63313a;
  border-radius: 11px;
  background: #2a1419;
  color: #ff9cab;
  font-size: 13px;
}
.links { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 20px; font-size: 14px; }
footer { display: flex; justify-content: space-between; gap: 20px; padding: 22px 4px; color: #70798a; font-size: 12px; }

@media (max-width: 720px) {
  .shell { padding-top: 34px; }
  .hero { display: grid; }
  .status-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 460px) {
  .status-grid { grid-template-columns: 1fr; }
  .actions .button { flex: 1; }
  footer { display: grid; }
}`;

export const ADMIN_SCRIPT = `(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const channelInput = byId("channelInput");
  const tokenInput = byId("tokenInput");
  const rememberInput = byId("rememberInput");
  const startButton = byId("startButton");
  const stopButton = byId("stopButton");
  const refreshButton = byId("refreshButton");
  const actionMessage = byId("actionMessage");

  const storedChannel = localStorage.getItem("blmfRelayChannel");
  if (storedChannel) channelInput.value = storedChannel;

  const storedToken = localStorage.getItem("blmfRelayToken");
  if (storedToken) {
    tokenInput.value = storedToken;
    rememberInput.checked = true;
  } else {
    tokenInput.value = sessionStorage.getItem("blmfRelayToken") || "";
  }

  function saveCredentials() {
    const channel = channelInput.value.trim();
    if (channel) localStorage.setItem("blmfRelayChannel", channel);

    const token = tokenInput.value;
    if (rememberInput.checked) {
      localStorage.setItem("blmfRelayToken", token);
      sessionStorage.removeItem("blmfRelayToken");
    } else {
      localStorage.removeItem("blmfRelayToken");
      sessionStorage.setItem("blmfRelayToken", token);
    }
  }

  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ja-JP");
  }

  function phaseLabel(phase) {
    return ({
      stopped: "停止中",
      discovering: "配信を検索中",
      waiting: "配信待機中",
      running: "取得中",
      error: "エラー"
    })[phase] || phase;
  }

  function setLink(element, value) {
    if (!value) {
      element.hidden = true;
      element.removeAttribute("href");
      return;
    }
    element.hidden = false;
    element.href = value;
  }

  function render(status) {
    const badge = byId("phaseBadge");
    badge.dataset.phase = status.phase;
    badge.textContent = phaseLabel(status.phase);

    byId("channelStatus").textContent = status.channel.title
      ? status.channel.title + " (" + status.channel.id + ")"
      : status.channel.configured || "—";
    byId("broadcastStatus").textContent = status.broadcast.title
      ? status.broadcast.title + " (" + status.broadcast.videoId + ")"
      : "—";
    byId("commentCount").textContent = String(status.commentCount);
    byId("nextActionAt").textContent = formatDate(status.nextActionAt);
    byId("lastPollAt").textContent = formatDate(status.lastPollAt);
    byId("lastFlushAt").textContent = formatDate(status.lastFlushAt);
    byId("updatedAt").textContent = "更新: " + formatDate(status.updatedAt);

    const errorBox = byId("errorBox");
    errorBox.hidden = !status.lastError;
    byId("errorText").textContent = status.lastError || "";

    setLink(byId("commentsLink"), status.urls.comments);
    setLink(byId("statusLink"), status.urls.status);
    setLink(byId("archiveLink"), status.urls.archive);

    if (!channelInput.value && status.channel.configured) {
      channelInput.value = status.channel.configured;
    }
  }

  async function readJson(response) {
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    if (!response.ok) {
      throw new Error(body && body.error ? body.error : "HTTP " + response.status);
    }
    return body;
  }

  async function refreshStatus(showMessage) {
    try {
      const status = await readJson(await fetch("/api/status", { cache: "no-store" }));
      render(status);
      if (showMessage) actionMessage.textContent = "状態を更新しました。";
    } catch (error) {
      actionMessage.textContent = "状態取得に失敗しました: " + error.message;
    }
  }

  async function sendAction(path, body) {
    saveCredentials();
    const token = tokenInput.value.trim();
    if (!token) {
      actionMessage.textContent = "管理トークンを入力してください。";
      return;
    }

    startButton.disabled = true;
    stopButton.disabled = true;
    actionMessage.textContent = "処理中…";
    try {
      const status = await readJson(await fetch(path, {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body || {})
      }));
      render(status);
      actionMessage.textContent = path.endsWith("start")
        ? "開始しました。配信の自動検出を行います。"
        : "停止しました。";
    } catch (error) {
      actionMessage.textContent = "操作に失敗しました: " + error.message;
    } finally {
      startButton.disabled = false;
      stopButton.disabled = false;
    }
  }

  startButton.addEventListener("click", () => {
    sendAction("/api/start", { channel: channelInput.value.trim() });
  });
  stopButton.addEventListener("click", () => sendAction("/api/stop", {}));
  refreshButton.addEventListener("click", () => refreshStatus(true));
  rememberInput.addEventListener("change", saveCredentials);
  tokenInput.addEventListener("change", saveCredentials);
  channelInput.addEventListener("change", saveCredentials);

  refreshStatus(false);
  window.setInterval(() => refreshStatus(false), 5000);
})();`;

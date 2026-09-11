# BLMF Chat Relay 設計

## 1. 目的

YouTube と Twitch のライブチャットを1つのコメントフィードへ集約し、Cloudflare R2 の `comments.json` と差分APIから利用できるようにする。

運用条件はイベント等の**限定期間だけ利用する**ことを前提とする。YouTube と Twitch は個別に開始・停止でき、長期常駐サービス向けの複雑な認証基盤より、短期間の運用を簡単に開始できることを優先する。

## 2. コンポーネント

### Worker エントリポイント

責務:

- 管理画面、CSS、JavaScriptの配信
- YouTube / Twitch の開始・停止・状態取得 API
- Bearer トークン認証
- 単一 Durable Object への RPC
- 差分APIの公開
- セキュリティヘッダーと構造化エラーログ

旧 `/api/twitch/eventsub` は存在しない。Twitchからのpublic webhook callbackは受けない。

### Durable Object `YouTubeChatRelay`

責務:

- リレー状態の永続化
- YouTube API 呼び出しのスケジューリング
- Twitch IRC WebSocket の接続・再接続
- Twitch IRCイベントの永続キュー化
- コメントの重複排除・削除反映
- R2 スナップショットの生成
- 配信終了・エラー・手動停止の状態遷移

YouTube の開始・停止・discovery・polling、R2 write、Twitchの接続状態変更はインスタンス内の Promise チェーン `runSerially()` で直列化する。外部 I/O 中に別処理が `relay_state` を古い値で上書きしないためである。

Twitch IRC socket callbackで例外的に直列化の外で行うのは、状態を書き換えない `PING -> PONG` と、受信イベントを `twitch_pending` にdurable enqueueする処理だけである。JOIN確認・NOTICE・切断・再接続状態の保存は必ず `runSerially()` へ投入する。

### R2

- `comments.json`: 現在または最後に停止したrunのコメント配列
- `status.json`: 公開状態
- `streams/{videoId}/comments.json`: YouTubeを含むrunの配信別スナップショット
- `streams/twitch-{channel}/{runId}/comments.json`: Twitch単独runのアーカイブ

R2へはWorker内からREST APIを呼ばず、R2 bindingを使用する。

## 3. 状態

### YouTube

| phase | 意味 |
|---|---|
| `stopped` | 無効。YouTube API呼び出しなし |
| `discovering` | チャンネル解決またはライブ配信検索中 |
| `waiting` | ライブ未検出。低頻度の再検索待ち |
| `running` | ライブチャット取得中 |
| `error` | 再試行待ち、または致命的エラーで停止 |

主な永続フィールド:

- `enabled`
- `runId`
- `channelRef`, `channelId`, `channelTitle`
- `videoId`, `videoTitle`, `liveChatId`
- `nextPageToken`
- `startedAt`, `lastPollAt`, `lastFlushAt`, `nextActionAt`
- `lastError`, `consecutiveErrors`

### Twitch

`relay_state.twitch` に以下を保持する。

- `enabled`
- `channel`
- `broadcasterId`: コメントID用source namespace
- `phase`: `stopped | waiting | running | error`
- `startedAt`, `lastReceivedAt`, `lastError`
- `flushAt`
- `reconnectAt`
- `subscriptions`: EventSub時代との状態互換用。IRC接続成立時は内部的に `irc` を入れて `ready` 表示を作る

`broadcasterId` は名称上は旧EventSub由来だが、現在は**Twitchコメントの永続namespace**として使う。EventSubからIRCへin-place移行する際、同一channelに既存の数値broadcaster idが保存されていればその値を継承する。これにより既存runの `twitch:<numeric-id>:...` コメントへIRCの `CLEARMSG/CLEARCHAT` を継続適用できる。新規環境ではchannel loginをnamespaceに使う。

`runId` はコメントテーブルのパーティションキーであり、無関係な配信のコメントを混同しないために使う。

## 4. SQLite スキーマ

主要テーブル:

```sql
CREATE TABLE relay_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL
);

CREATE TABLE comments (
  run_id TEXT NOT NULL,
  id TEXT NOT NULL,
  author_channel_id TEXT,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);

CREATE TABLE comment_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('upsert', 'delete')),
  comment_id TEXT NOT NULL,
  name TEXT,
  message TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE twitch_pending (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery TEXT NOT NULL
);

CREATE TABLE twitch_receipts (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
);

CREATE TABLE twitch_moderation (
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, target)
);
```

`twitch_pending` はtransport-neutralなTwitchイベントキューとして使う。IRC frameを正規化した後、YouTube/R2の外部I/Oを待たずここへ保存する。

`twitch_receipts` は同一イベントの二重適用防止に使う。IRCの `PRIVMSG` ではTwitch message idが安定したdedupe keyになる。

`twitch_moderation` は削除がメッセージより先に届いた場合でも後着メッセージを復活させないために使う。

## 5. YouTube: チャンネルからライブチャットまで

1. `channels.list`
   - チャンネルIDなら `id`
   - ハンドルなら `forHandle`
   - 旧username URLなら `forUsername`
2. `search.list`
   - `channelId=<resolved id>`
   - `eventType=live`
   - `type=video`
3. `videos.list`
   - `part=snippet,liveStreamingDetails`
   - `activeLiveChatId` があり、終了していない動画を選ぶ
4. `liveChatMessages.list`
   - `part=id,snippet,authorDetails`
   - `nextPageToken` を保存
   - `pollingIntervalMillis` に従って次回処理時刻を保存

同時に複数のライブが見つかった場合は、`actualStartTime` が最も新しいものを採用する。

### 限定公開E2E専用経路

`POST /api/e2e/start` は管理トークンに加えてチャンネルと既知の11文字の動画IDを受け取る。`search.list` は使わず、次の順に検証する。

1. 通常経路と同じ方法で指定チャンネルを解決
2. `videos.list(id=<videoId>)` で動画を直接取得
3. `snippet.channelId` が解決済みチャンネルIDと一致することを確認
4. `actualStartTime` があり、`actualEndTime` がなく、`activeLiveChatId` があることを確認
5. 同じpolling処理へ接続

## 6. Twitch: 匿名IRC

`POST /api/twitch/start` でDOが次へ接続する。

```text
wss://irc-ws.chat.twitch.tv:443
```

接続後:

```text
CAP REQ :twitch.tv/tags twitch.tv/commands
PASS SCHMOOPIIE
NICK justinfan#####
JOIN #<channel>
```

OAuth、Client ID、EventSub subscription、Webhook secretは使用しない。

### 接続成立判定

WebSocket `open` や IRC `001 Welcome` だけでは `running` にしない。これらはIRCセッション成立しか証明しないためである。

次のいずれかを対象channelで受けた時点で `running` / `ready` とする。

- `JOIN`
- `ROOMSTATE`
- `PRIVMSG`

### IRCイベント変換

- `PRIVMSG` -> `message`
- `CLEARMSG` -> `delete`
- `CLEARCHAT` + `target-user-id` -> `clear-user`
- `CLEARCHAT` without target -> `clear`
- `PING` -> 即時 `PONG`
- `RECONNECT` -> socket切断 + `reconnectAt` 設定

`PRIVMSG` の `tmi-sent-ts` を `created_at` に使う。

### socket callbackと直列化

socket callbackから `relay_state` を直接 `load -> save` してはいけない。R2やYouTube APIをawait中にcallbackが保存すると、外部I/O完了後の古いstate保存で状態を巻き戻す競合が発生するためである。

- `PONG`: stateを書かないため同期送信
- message: `twitch_pending` へ即時enqueue
- JOIN/ROOMSTATE/NOTICE/close/error/RECONNECT: `runSerially()` へ状態変更を投入

古いsocket callbackが新しいsocketの状態を壊さないよう、インメモリのgenerationを照合する。

## 7. コメント変換

R2へ出す公開形式は3項目のみ。

```ts
interface ExportedComment {
  name: string;
  message: string;
  created_at: string;
}
```

内部では重複排除・削除反映のためmessage idとauthor idも保持する。

Twitch内部IDは次の形式。

```text
twitch:<source-namespace>:<message-id>
```

削除イベントはYouTubeコメントには影響しない。

## 8. スケジューリング

Durable Object Alarmは1個しか持てない。個別処理が自由に `setAlarm()` して最後に書いたdeadlineで上書きする設計にはしない。

`nextRelayAlarm()` が次の候補の**最小時刻**を選ぶ。

- YouTube discovery/poll: `nextActionAt`
- Twitch snapshot flush: `twitch.flushAt`
- Twitch reconnect: `twitch.reconnectAt`
- Twitch接続watchdog: Twitch有効中は約60秒後
- 停止後R2 retry: `nextActionAt`

Twitch切断callbackは `reconnectAt` をstateへ保存するだけで、直接 `setAlarm(reconnectAt)` しない。`runSerially()` のfinallyで全候補を再評価するため、例えば500ms後のYouTube pollがある状態で1秒後のIRC reconnectが発生しても、Alarmは500msを維持する。

`twitch_pending` enqueueだけは処理遅延を避けるため即時Alarmをarmしてよい。これは既存deadlineを**早めるだけ**であり、queue drain後に再度最小deadlineへ収束する。

## 9. R2 書き込み

通常は `R2_FLUSH_INTERVAL_SECONDS` ごとに以下を書き込む。

1. 最新 `comments.json`
2. 配信別またはTwitch単独archive
3. 上記成功後に `status.json`

コメント本体とarchiveは並列化し、statusは最後に書く。部分成功でstatusだけ新しくなる状態を避ける。

次の場合は間隔を待たず強制反映する。

- 新規開始
- 配信を発見
- 配信未検出へ遷移
- 手動停止
- 配信終了
- エラー状態へ遷移

`Cache-Control: no-store, max-age=0, must-revalidate` を設定する。

## 10. エラー処理

### YouTube: 自動停止

- APIキー不正
- YouTube Data API 未有効
- クォータ枯渇
- 権限不足
- ライブチャット無効
- チャンネル不正

### YouTube: 再試行

- ネットワークエラー
- YouTube 5xx
- `rateLimitExceeded`
- その他一時的エラー

2秒から最大5分まで指数バックオフする。

### Twitch

WebSocket `error` / `close` は1秒から最大30秒の指数バックオフで再接続する。Twitch `RECONNECT` は即時再接続deadlineを設定する。

DOがevict/recreateされた場合は永続 `twitch.enabled` とAlarm watchdogからsocketを再作成する。outbound WebSocketはWebSocket Hibernation APIの対象ではないため、Twitch開始中は通常のoutbound接続として動作する。

### R2

停止後の最終反映失敗は30秒後をretry deadlineとしてstateへ保存し、共有Alarmの最小deadline選択へ入れる。

## 11. セキュリティ

- `YOUTUBE_API_KEY` と `ADMIN_TOKEN` はSecret
- Twitch用Secret/OAuth tokenは持たない
- 開始・停止はBearer認証
- 限定公開E2E開始もBearer認証し、対象YouTubeチャンネルとの一致を検証
- 管理トークン比較はWeb Cryptoを使用
- 状態取得は公開R2相当の情報のみ
- 管理画面は厳格なCSPを設定し、外部スクリプトを読み込まない
- APIレスポンスと管理画面は `no-store`
- ログに管理トークン、APIキー、コメント本文、視聴者名を出さない

管理面を独自ドメインに割り当てる場合はCloudflare Accessを追加する。

## 12. 整合性

- 外部I/Oを含む状態変更は `runSerially()` で直列化する
- Twitchコメント本体は先にdurable queueへ保存し、後から同じ直列処理へ合流する
- socket generationでstale callbackを無視する
- `runId` で古い配信単位の結果を現在stateへ適用しない
- Alarmは全deadlineの最小値に一本化する
- R2書き込みは完全なsnapshotで冪等に収束させる
- EventSub -> IRC移行時は同一channelの旧source namespaceを継承する

## 13. 制約と将来案

### 現行制約

- リレー開始以前の全チャット履歴を保証しない
- Twitch IRCは接続中に受信したイベントのみ対象
- Twitch有効中のoutbound WebSocketはDO Hibernation対象外
- 単一JSON配列のため、高コメント量ではR2転送量が増える
- YouTubeの検索クォータを使うため、配信待機の常時稼働を想定しない
- 単一Twitchチャンネル・単一YouTube同時配信を対象とする

### 将来案

- `liveChatMessages.streamList` の検証
- `comments.json` 互換出力を維持した内部チャンク化
- 複数チャンネル対応（チャンネルごとにDurable Objectを分割）
- Cloudflare Access前提の管理ドメイン
- R2ライフサイクルルールによる古いarchive整理

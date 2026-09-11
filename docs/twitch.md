# Twitch チャット（匿名IRC）

Twitchチャットは `wss://irc-ws.chat.twitch.tv:443` へ匿名IRC-over-WebSocketで接続し、YouTubeと同じ `comments.json`、`/api/comments/delta`、`/api/comments/delta/simple` に統合します。

このリレーはイベント等の限定期間だけ利用する前提です。Twitch EventSub Webhookは使いません。Twitch Client ID、OAuth token、EventSub subscription、Webhook secret、公開callback endpointはいずれも不要です。

## 設定

`wrangler.jsonc` の `DEFAULT_TWITCH_CHANNEL` に読み取り対象のチャンネルloginを設定します。

```json
"DEFAULT_TWITCH_CHANNEL": "azumagbanjo"
```

Twitch用secretはありません。Worker側で必要なsecretはYouTube API keyと管理トークンだけです。

## 動作

管理画面または `POST /api/twitch/start` でTwitchを開始すると、Durable ObjectがIRC WebSocketを開きます。

接続時には次を送信します。

```text
CAP REQ :twitch.tv/tags twitch.tv/commands
PASS SCHMOOPIIE
NICK justinfan#####
JOIN #<channel>
```

`justinfan#####` は実行ごとに生成する匿名guest nickです。チャット送信機能は持たず、read-onlyで利用します。

受信したIRCイベントは直接R2へ書かず、既存の `twitch_pending` SQLiteキューへ永続化します。その後、Durable Object Alarmと既存の直列化処理でコメント状態へ反映し、設定された間隔でR2 snapshotを更新します。これによりYouTubeの外部I/OやR2書き込み中にIRCイベントが届いても既存の整合性モデルを維持します。

対応IRCイベント:

- `PRIVMSG` → コメント追加
- `CLEARMSG` → 1コメント削除
- `CLEARCHAT` + `target-user-id` → 投稿者単位の削除
- `CLEARCHAT` without target → Twitchコメント全削除
- `PING` → 即時 `PONG`
- `RECONNECT` → WebSocket再接続

`PRIVMSG` の `id`、`user-id`、`display-name`、`tmi-sent-ts` を利用します。公開JSON形式は従来どおり `name`, `message`, `created_at` の3項目です。

内部コメントIDは `twitch:<source-namespace>:<message-id>` です。新規環境では `<source-namespace>` にchannel loginを使います。EventSub版から同一channelの既存runを引き継ぐ場合は、保存済みの数値 `broadcasterId` をnamespaceとして維持します。これによりデプロイ直後でも、IRCの `CLEARMSG` / `CLEARCHAT` がEventSub時代のコメントに引き続き作用します。

## 接続成立判定

WebSocket `open` やIRC `001 Welcome` だけでは接続完了扱いにしません。対象channelの `JOIN` / `ROOMSTATE`、または実際の `PRIVMSG` を受信して初めて管理画面の状態を `running` にします。

## 再接続

WebSocketの `close` / `error` / Twitch `RECONNECT` を検出すると再接続します。一時的な失敗では1秒から最大30秒まで指数バックオフします。

Cloudflare Durable ObjectsのWebSocket Hibernation APIはoutbound WebSocketには使えないため、Twitch開始中は通常のoutbound接続として維持します。DOが再生成・evictされた場合にも復帰できるよう、Twitch有効中は約60秒周期のAlarmを接続watchdogとして残します。

Durable ObjectのAlarmは1本だけなので、IRC切断時に再接続時刻を直接上書きせず `reconnectAt` として永続化します。YouTube poll、R2 retry、Twitch flush、IRC reconnect、watchdogのうち最も早い時刻を共通Alarmへ設定します。

このサービスは限定期間だけ利用する前提なので、長期常駐サービス向けのコスト最適化より、設定不要で確実に再接続できる単純な構成を優先しています。

## 開始・停止

- `POST /api/twitch/start`: IRC接続を開始します。既に有効な場合も接続を張り直します。
- `POST /api/twitch/stop`: IRC接続を閉じ、最終snapshotをR2へ反映します。
- どちらも既存の `Authorization: Bearer <ADMIN_TOKEN>` が必要です。

YouTubeとTwitchは個別に開始・停止できます。YouTubeが終了・停止してもTwitchは明示的に停止するまで継続します。

Twitch単独runのarchiveは `streams/twitch-<channel>/<runId>/comments.json`、YouTube併用時は従来どおり動画別archiveを使います。

## 運用確認

開始後は管理画面でTwitch状態が `running` になることを確認し、実際のコメントを1件投稿して以下を確認してください。

1. 管理画面の最終受信時刻が更新される
2. `/api/comments/delta/simple` にTwitchコメントが出る
3. `comments.json` に反映される
4. コメント削除・timeout時にdeltaへ `delete` が出る

`/api/twitch/eventsub` は廃止されています。

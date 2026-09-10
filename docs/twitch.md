# Twitch チャット（azumagbanjo）

Twitch EventSub Webhookから受信し、YouTubeと同じ `comments.json`、`/api/comments/delta`、`/api/comments/delta/simple` に出力します。既存の3項目 (`name`, `message`, `created_at`) と差分APIの形式は維持します。差分のTwitchコメントID・内部投稿者IDには `twitch:<broadcaster_id>:` を付け、YouTubeとの衝突を防ぎます。

## 初回設定

1. [Twitch Developer Console](https://dev.twitch.tv/console/apps)で、この用途のアプリを登録します。同じアプリに対して、チャットを読むユーザーから `user:read:chat` と `user:bot` の認可を取得してください。さらに配信者 `azumagbanjo` から `channel:bot` の認可を取得するか、読むユーザーをそのチャンネルのモデレーターにします。Webhook購読を登録するのは **app access token** です。ユーザーの認可取得手順は[Twitch公式ガイド](https://dev.twitch.tv/docs/chat/authenticating/)に従います。送信権限は不要です。
2. ローカルの安全な環境に `TWITCH_CLIENT_ID` と `TWITCH_APP_ACCESS_TOKEN` を設定し、`node scripts/twitch-setup.mjs inspect` を実行します。既定の `azumagbanjo` を解決し、公開情報の数値IDだけを表示します。
3. その数値IDを `wrangler.jsonc` の `TWITCH_BROADCASTER_ID` に設定します。`DEFAULT_TWITCH_CHANNEL` は `azumagbanjo` のままです。暗号学的にランダムなWebhook用secret（10〜100文字のASCII）を用意し、`npx wrangler secret put TWITCH_EVENTSUB_SECRET` でWorkerに登録します。同じ値を購読設定用の環境変数 `TWITCH_EVENTSUB_SECRET` に設定してください。secretやアクセストークンをソースやチャットへ貼り付けないでください。
4. Workerを通常のリリース手順で配備します。YouTube用の既存設定はそのまま維持してください。
5. 設定用の環境変数 `TWITCH_BROADCASTER_ID`、`TWITCH_CHAT_USER_ID`（認可した読み取りユーザーの数値ID）、`TWITCH_CALLBACK_URL=https://<Workerのホスト>/api/twitch/eventsub` を設定し、`node scripts/twitch-setup.mjs subscribe` を実行します。**R2の公開ホストではなく、管理画面を配信するWorkerのホスト**を指定してください。このコマンドが4種類の購読を登録します。同一の既存購読は変更しません。
6. 管理画面に管理トークンを入力し、「Twitch 開始」を押します。4種類の署名付き確認通知を受け取ると「受信待機中」になります。`azumagbanjo` のチャットで実際に投稿し、管理画面の最終受信・JSON・差分APIへの反映を確認してください。「受信待機中」だけでは実チャット到達の証明にはなりません。

ローカル検証では `.dev.vars.example` を参考にダミーsecretと設定を用意します。単体テストと `npm run test:runtime` はダミーイベントとローカルR2のみを使い、Twitchや本番R2に接続しません。

## 操作と出力

- `POST /api/twitch/start` / `POST /api/twitch/stop` は既存の `Authorization: Bearer <ADMIN_TOKEN>` で操作します。チャンネルはWorker設定で固定します。
- YouTubeの開始・停止は既存の `/api/start` / `/api/stop` です。状態APIの既存 `enabled` / `phase` はYouTubeを示し、新しい `twitch` オブジェクトがTwitchの状態を示します。どちらも有効なら同一の一覧に混在します。
- YouTubeの終了・エラー・手動停止でもTwitchは継続します。Twitchはオフラインのチャットも受信するため、必要なタイミングで個別に停止してください。「停止」は保存を止めます。EventSub購読自体は残り、Twitchから通知は届きます。接続を完全に解除する場合はTwitchの購読を削除してください。
- 両方が停止した後の新しい開始でセッションを切り替えます。片方が動作中に他方を開始した場合は同じセッションとコメントを保持します。Twitch単独のアーカイブは `streams/twitch-azumagbanjo/<runId>/comments.json`、YouTube併用時は既存の動画別アーカイブです。
- Twitchの `created_at` はEventSubメッセージのタイムスタンプです。イベントに投稿時刻フィールドがないため、厳密な投稿時刻ではありません。配信元フィールドは公開JSONへ追加していません。
- Twitchの削除・投稿者ごとのクリア・全クリアはTwitchコメントだけを対象にし、差分には `delete` を追記します。遅れて到着した削除対象メッセージも復活させません。ただし判定はWebhookのタイムスタンプ同士の比較のため、初回配信に失敗し再送されたメッセージ（タイムスタンプが再送時刻に更新される）がクリアの後に届いた場合は、この限りではありません。該当メッセージのIDが分かれば `channel.chat.message_delete` の再送でタイムスタンプに関係なく永続的に抑制できます。
- 通知は署名、時刻、購読種別、配信者を検証し、永続キューへの保存後に応答します。YouTube APIやR2の応答をWebhookが待つことはありません。重複通知は除外します。R2は設定された保存間隔で反映し、失敗時は再試行します。通知が1件だけでも反映されます。

## 接続エラー

認可取消などで購読が失効した場合はTwitch欄に理由を表示します。認可を直して購読を再登録してください。既存購読が失効状態の場合やsecretを変更した場合は、対象の購読を削除してから登録し直します。管理画面の「開始」だけでは認可や購読を修復しません。

対応イベント: `channel.chat.message`、`channel.chat.message_delete`、`channel.chat.clear_user_messages`、`channel.chat.clear`（すべてversion 1）。

仕様: [Webhookの署名・応答](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/)、[イベント定義](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)。

# 差分コメント取得 API

## 概要

BLMF Chat Relay が保持している YouTube ライブコメントについて、クライアントが毎回 `comments.json` を全件取得・全件パースせず、前回取得後に発生した変更だけを受け取るための公開 API です。

ワールド側は `streamId` と `nextCursor` を保持し、通常は10秒ごとに差分だけを取得します。コメント総数ではなく、新着・更新・削除の件数に応じた処理量に抑えられます。

## エンドポイント

```http
GET https://blmf-chat-relay.tsubasa-azumagakito.workers.dev/api/comments/delta
```

このAPIは **Cloudflare WorkerのURL** に対して呼び出します。

次のR2カスタムドメインは静的JSON配信用であり、差分APIの呼び出し先ではありません。

```text
https://chat.blmf.bluemoon.works
```

## クエリパラメーター

| パラメーター | 必須 | 説明 |
|---|---:|---|
| `streamId` | 任意 | 前回応答の `streamId`。配信・リレー実行の切り替え検知に使用 |
| `after` | 任意 | 前回応答の `nextCursor`。この連番より後のイベントだけを返す |
| `limit` | 任意 | 1回に返す最大イベント数。既定50、最大200 |

`after` は0以上の安全な整数、`limit` は1〜200の整数です。`streamId` は最大128文字です。

## 初回取得

初回はパラメーターを付けずに呼び出します。

```http
GET /api/comments/delta
```

応答例:

```json
{
  "streamId": "3fdc0f32-5b4a-4c67-9059-a5f97db9237d",
  "events": [],
  "nextCursor": 124,
  "hasMore": false,
  "reset": false
}
```

初回取得では、過去コメントを全件返しません。現在の末尾カーソルだけを返し、以後に発生した変更から受信を開始します。途中参加・再起動直後に大量のコメントを一度にパースしないための仕様です。

## 2回目以降の取得

前回応答の `streamId` と `nextCursor` を送ります。

```http
GET /api/comments/delta?streamId=3fdc0f32-5b4a-4c67-9059-a5f97db9237d&after=124&limit=50
```

応答例:

```json
{
  "streamId": "3fdc0f32-5b4a-4c67-9059-a5f97db9237d",
  "events": [
    {
      "seq": 125,
      "type": "upsert",
      "id": "youtube-message-id",
      "name": "視聴者名",
      "message": "コメント本文",
      "created_at": "2026-08-31T01:23:45.000Z"
    }
  ],
  "nextCursor": 125,
  "hasMore": false,
  "reset": false
}
```

## 応答フィールド

| フィールド | 説明 |
|---|---|
| `streamId` | 現在のリレー実行を表すID。開始対象が切り替わると変わる |
| `events` | `after` より後に発生した変更。`seq` の昇順 |
| `nextCursor` | 次回の `after` にそのまま指定する値 |
| `hasMore` | 上限のため未返却イベントが残っている場合は `true` |
| `reset` | クライアントの配信状態またはカーソルが現在状態と一致しない場合は `true` |

`seq` はサーバーが発行する単調増加の連番です。投稿日時をカーソルにしないため、同一時刻に複数コメントがあっても取りこぼしません。

## イベント種別

### `upsert`

新規コメント、または同じコメントIDの内容更新です。クライアント側は `id` をキーに追加または置換します。

```json
{
  "seq": 125,
  "type": "upsert",
  "id": "youtube-message-id",
  "name": "視聴者名",
  "message": "コメント本文",
  "created_at": "2026-08-31T01:23:45.000Z"
}
```

同じYouTubeページを再取得しても、保存済みコメントと内容が同じなら新しいイベントは追加しません。

### `delete`

YouTube上でのコメント削除、または投稿者BANによる削除です。クライアント側は `id` をキーにコメントを削除します。

```json
{
  "seq": 126,
  "type": "delete",
  "id": "youtube-message-id",
  "name": null,
  "message": null,
  "created_at": "2026-08-31T01:24:10.000Z"
}
```

投稿者BANの場合、その投稿者について現在保存されているコメントごとに `delete` イベントを返します。

## 配信切り替えとリセット

新しいリレー実行が始まると `streamId` が変わります。古い `streamId` を送った場合は、現在位置へ安全にリセットします。

```json
{
  "streamId": "new-stream-id",
  "events": [],
  "nextCursor": 230,
  "hasMore": false,
  "reset": true
}
```

この場合、クライアントは古い配信のローカル状態を破棄し、返された `streamId` と `nextCursor` から取得を再開します。`after` が現在の末尾より大きい場合も `reset: true` になります。

## クライアント実装例

```text
streamId = null
cursor = null

10秒ごとに:
  GET /api/comments/delta?streamId=<streamId>&after=<cursor>&limit=50

  reset が true、または保存中の streamId と応答の streamId が異なる:
    ローカルのコメント状態をクリアする

  events を seq 順に適用する:
    upsert -> id をキーに追加・置換
    delete -> id をキーに削除

  streamId = 応答.streamId
  cursor = 応答.nextCursor

  hasMore が true:
    10秒待たず、更新した cursor ですぐ次ページを取得する
```

通信失敗時は、保存済みの同じカーソルで再試行できます。同じ `after` を再送すると同じイベントが返り得るため、クライアント側でも `seq` または `id` を使って冪等に適用してください。`nextCursor` を永続化する場合は、応答内イベントをすべて適用した後に保存します。

## HTTP・CORS仕様

- 認証不要
- `GET` と `OPTIONS` に対応
- `Access-Control-Allow-Origin: *`
- 不正なクエリは HTTP 400
- `GET` / `OPTIONS` 以外は HTTP 405
- 通常応答は `Cache-Control: no-store`

## 既存機能への影響

外部互換性は維持されています。次の既存機能・形式は変更していません。

| 既存機能 | 影響 |
|---|---|
| `GET /health` | 変更なし |
| `GET /api/status` | 変更なし |
| `POST /api/start` | 変更なし |
| `POST /api/e2e/start` | 変更なし |
| `POST /api/stop` | 変更なし |
| 管理画面 | 変更なし |
| R2 `comments.json` | 形式・出力を維持 |
| R2 `status.json` | 形式・出力を維持 |
| `streams/{videoId}/comments.json` | 形式・出力を維持 |
| 既存クライアント | 修正不要。従来どおり全件JSONを利用可能 |

内部では Durable Object SQLite に `comment_events` テーブルを追加し、コメントの新規・更新・削除時にイベントを追記します。配信切り替え時には、正常にアーカイブできた古い実行のコメントとイベントを削除します。

なお、差分APIはワールド側の全件取得・全件パースを解消するものです。後方互換のため、リレー側によるR2の全件スナップショット生成は引き続き行います。

## テスト済み項目

- 新着なし
- 同一時刻の複数コメント
- 同一カーソルでの再取得
- 複数ページと上限到達
- 配信切り替え
- 範囲外カーソル
- コメント更新
- 個別コメント削除
- 投稿者BANによる複数削除
- 既存R2出力との互換性

Wrangler型生成、TypeScript型検査、Vitest 23件が成功した状態で `main` にマージされています。

## 本番確認

```bash
curl -i \
  'https://blmf-chat-relay.tsubasa-azumagakito.workers.dev/api/comments/delta'
```

HTTP 404になる場合は、Cloudflare Workerが差分API追加前のコミットを実行している可能性があります。最新の `main` をデプロイしてから再確認してください。

## 関連情報

- Issue #3: 差分コメント取得APIを追加し、ワールド側の全件パースを解消する
- PR #5: feat: 差分コメント取得APIを追加
- リポジトリ内詳細資料: `docs/delta-api.md`
- マージコミット: `3a3ad388dfb2cd1e4ade539d86f7146c748b651c`

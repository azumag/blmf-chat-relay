# 差分コメント取得 API

ワールド側が `comments.json` の全件取得・全件パースを繰り返さず、前回取得後に発生した変更だけを受け取るための公開 API です。

既存の R2 出力である `comments.json`、`status.json`、`streams/{videoId}/comments.json` は変更せず、そのまま利用できます。

## エンドポイント

```http
GET /api/comments/delta
```

この API は Worker の URL に対して呼び出します。R2 カスタムドメインではありません。

例:

```text
https://blmf-chat-relay.<YOUR_SUBDOMAIN>.workers.dev/api/comments/delta
```

認証は不要です。公開済みのコメント情報だけを返し、ブラウザから取得できるよう `Access-Control-Allow-Origin: *` を返します。

## クエリパラメーター

| パラメーター | 必須 | 説明 |
|---|---:|---|
| `streamId` | 任意 | 前回応答の `streamId`。配信・実行の切替検知に使う |
| `after` | 任意 | 前回応答の `nextCursor`。この連番より後のイベントだけを返す |
| `limit` | 任意 | 1回に返す最大イベント数。既定50、最大200 |

初回はパラメーターなしで呼び出します。

```http
GET /api/comments/delta
```

初回応答では過去の全履歴を返さず、現在の末尾カーソルだけを返します。これにより、途中参加や再起動直後に大量のコメントを一度にパースすることを避けます。

2回目以降は前回の値を送ります。

```http
GET /api/comments/delta?streamId=3fdc...&after=124&limit=50
```

## 応答

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
      "created_at": "2026-08-27T01:23:45.000Z"
    }
  ],
  "nextCursor": 125,
  "hasMore": false,
  "reset": false
}
```

### 各フィールド

- `streamId`: 現在のリレー実行を表すID。開始対象が切り替わると変わる
- `events`: `after` より後に発生した変更。`seq` の昇順
- `nextCursor`: 次回の `after` にそのまま指定する値
- `hasMore`: 上限のため未返却イベントが残っている場合は `true`
- `reset`: クライアントの `streamId` またはカーソルが現在状態と一致しない場合は `true`

`seq` はサーバーが発行する単調増加の連番です。同じ投稿時刻のコメントが複数あっても、時刻をカーソルにしないため取りこぼしません。

## イベント種別

### `upsert`

新規コメントまたは同じコメントIDの更新です。クライアント側は `id` をキーに追加または置換します。

```json
{
  "seq": 125,
  "type": "upsert",
  "id": "youtube-message-id",
  "name": "視聴者名",
  "message": "コメント本文",
  "created_at": "2026-08-27T01:23:45.000Z"
}
```

### `delete`

YouTube上のコメント削除または投稿者BANにより、現在状態からコメントを除外するイベントです。クライアント側は `id` をキーに削除します。

```json
{
  "seq": 126,
  "type": "delete",
  "id": "youtube-message-id",
  "name": null,
  "message": null,
  "created_at": "2026-08-27T01:24:10.000Z"
}
```

投稿者BANでは、その投稿者について現在保存されているコメントごとに `delete` イベントを返します。

## クライアント処理例

```text
streamId = null
cursor = null

10秒ごとに:
  GET /api/comments/delta?streamId=<streamId>&after=<cursor>&limit=50

  応答の reset が true、または保存中の streamId と応答の streamId が異なる:
    ローカルのコメント状態をクリアする

  events を seq 順に適用する:
    upsert -> id をキーに追加・置換
    delete -> id をキーに削除

  streamId = 応答.streamId
  cursor = 応答.nextCursor

  hasMore が true:
    10秒待たず、更新した cursor ですぐ次ページを取得する
```

初回だけは `streamId` と `after` を送らないでください。応答の `events` は空で、以後に発生した変更から受信を開始します。

## 再取得と重複

同じ `after` と `limit` で再取得すると、同じ `seq` のイベントが再度返り得ます。通信失敗時は同じカーソルで安全に再試行できます。

クライアント側は、適用済みの最大 `seq` 以下を再適用しないか、`id` に対する `upsert` / `delete` を冪等に処理してください。`nextCursor` を永続化する場合は、応答内イベントの適用完了後に保存します。

## 配信切替

新しいリレー実行が開始されると `streamId` が変わります。古い `streamId` を送った場合、API は次の形式で現在位置へリセットします。

```json
{
  "streamId": "new-stream-id",
  "events": [],
  "nextCursor": 230,
  "hasMore": false,
  "reset": true
}
```

この場合、クライアントは古い配信のローカル状態を破棄し、返された `streamId` と `nextCursor` から取得を再開します。切替時に新しい配信の過去履歴を大量再生しない設計です。

## エラー

不正なクエリは HTTP 400 です。

- `after`: 0以上の安全な整数
- `limit`: 1〜200の整数
- `streamId`: 最大128文字

`GET` と `OPTIONS` 以外は HTTP 405 を返します。

# 差分コメント取得 API

BLMF Chat Relay には、用途の異なる2種類の差分取得APIがあります。

| API | 対象クライアント | 特徴 |
|---|---|---|
| `GET /api/comments/delta/simple` | URLやクエリパラメータを動的に変更できないワールド側クライアント | 固定URL。直近最大200件を毎回返し、クライアント側で `seq` を使って重複除外 |
| `GET /api/comments/delta` | クエリパラメータを組み立てられる一般クライアント | `streamId` とカーソルによる厳密な差分取得・ページング |

どちらもCloudflare WorkerのURLへアクセスします。次のR2カスタムドメインは静的JSON配信用であり、APIの呼び出し先ではありません。

```text
https://chat.blmf.bluemoon.works
```

---

# 固定URL版：`/api/comments/delta/simple`

ワールド側では取得URLを実行中に書き換えられないため、通常はこちらを使用します。

## エンドポイント

```http
GET https://blmf-chat-relay.tsubasa-azumagakito.workers.dev/api/comments/delta/simple
```

クエリパラメータ、リクエスト本文、認証は不要です。同じURLを通常10秒ごとに取得します。

## 応答例

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
  "windowStartCursor": 125,
  "latestCursor": 125,
  "truncated": false,
  "windowSize": 200
}
```

## 応答フィールド

| フィールド | 説明 |
|---|---|
| `streamId` | 現在のリレー実行ID。配信またはリレー実行が切り替わると変わる |
| `events` | 現在の実行に属する直近最大200件のイベント。`seq` 昇順 |
| `windowStartCursor` | 応答内で最も古いイベントの `seq`。イベントがなければ0 |
| `latestCursor` | 応答内で最も新しいイベントの `seq`。イベントがなければ0 |
| `truncated` | 200件より古いイベントを省略した場合は `true` |
| `windowSize` | 最大イベント件数。現在は200 |

## クライアントが保持する値

URLへ値を埋め込む必要はありません。ローカルには次の2値だけを保持します。

- 最後に確認した `streamId`
- 最後に適用した `seq`

## 推奨処理

```text
streamId = null
lastSeq = 0

10秒ごとに固定URLをGET:
  response = GET /api/comments/delta/simple

  初回:
    streamId = response.streamId
    lastSeq = response.latestCursor
    今回のeventsは処理しない

  response.streamId != streamId:
    ローカルのコメント状態をクリア
    streamId = response.streamId
    lastSeq = response.latestCursor
    今回のeventsは処理しない

  lastSeq + 1 < response.windowStartCursor:
    200件窓から取りこぼした状態
    警告を記録
    lastSeq = response.latestCursor
    今回のeventsは処理しない

  それ以外:
    eventsのうち seq > lastSeq のものだけをseq昇順に適用
      upsert -> idをキーに追加または置換
      delete -> idをキーに削除
    lastSeq = response.latestCursor
```

初回に直近イベントも処理したい場合は、`lastSeq = windowStartCursor - 1` としてから `events` を適用できます。通常のライブ連携では、起動時に過去コメントをまとめて再生しないよう、初回は `latestCursor` まで読み飛ばす方法を推奨します。

## 同じイベントが毎回答えに含まれる理由

固定URL版は、取得時にサーバー側カーソルを進めません。同じ状態なら、同じURLから同じ直近イベントが返ります。

クライアントが `seq > lastSeq` のイベントだけを適用することで、処理対象は実質的に新着分だけになります。

サーバー側でGETのたびに共有カーソルを進める方式は採用していません。この方式には次の問題があるためです。

- 応答の受信に失敗してもイベントが消費され、欠落する
- ブラウザで動作確認しただけで本番クライアント分のイベントを消費する
- 複数クライアントがあると、最初にアクセスした1台だけが受け取る

固定ウィンドウ方式なら、再試行や複数クライアントでも同じイベントを安全に取得できます。

## 200件窓と取りこぼし検知

固定URL版は直近200件までを返します。クライアント停止中や通信断の間に200件を超えるイベントが発生すると、古いイベントは取得できません。

次の条件で検出します。

```text
lastSeq + 1 < windowStartCursor
```

`truncated: true` は現在の配信に200件を超えるイベントが存在することを示します。ただし、クライアントが直前まで取得できていれば、`truncated: true` でも取りこぼしとは限りません。上記の `lastSeq` 比較で判断します。

すべてのイベントを厳密に回収する必要があり、クエリを変更できるクライアントは後述のカーソル版を使用します。

---

# カーソル版：`/api/comments/delta`

## エンドポイント

```http
GET https://blmf-chat-relay.tsubasa-azumagakito.workers.dev/api/comments/delta
```

## クエリパラメータ

| パラメータ | 必須 | 説明 |
|---|---:|---|
| `streamId` | 任意 | 前回応答の `streamId`。配信・実行の切替検知に使用 |
| `after` | 任意 | 前回応答の `nextCursor`。この連番より後だけを取得 |
| `limit` | 任意 | 1回の最大イベント数。既定50、最大200 |

## 初回取得

```http
GET /api/comments/delta
```

```json
{
  "streamId": "3fdc0f32-5b4a-4c67-9059-a5f97db9237d",
  "events": [],
  "nextCursor": 124,
  "hasMore": false,
  "reset": false
}
```

初回は過去履歴を返さず、現在位置だけを返します。

## 2回目以降

```http
GET /api/comments/delta?streamId=3fdc0f32-5b4a-4c67-9059-a5f97db9237d&after=124&limit=50
```

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

`hasMore: true` の場合は、更新された `nextCursor` を `after` に指定してすぐ次ページを取得します。`streamId` が変わった場合や、カーソルが現在範囲外の場合は `reset: true` が返ります。

---

# 共通イベント形式

## `upsert`

新規コメント、または同じコメントIDの更新です。クライアントは `id` をキーに追加または置換します。

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

同じYouTubeページを再取得しても、保存済み内容と同一ならイベントは追加されません。

## `delete`

YouTube上のコメント削除、または投稿者BANによる削除です。クライアントは `id` をキーに削除します。

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

投稿者BANでは、現在保存されているその投稿者の各コメントについて `delete` が発生します。

`seq` はサーバー発行の単調増加連番です。同じ投稿時刻のコメントが複数あっても、時刻をカーソルにしないため取りこぼしません。

# HTTP・CORS

両APIに共通です。

- 認証不要
- `GET` と `OPTIONS` に対応
- `Access-Control-Allow-Origin: *`
- `GET` / `OPTIONS` 以外は HTTP 405
- 通常応答は `Cache-Control: no-store`

# 既存機能への影響

固定URL版の追加によって、次の既存機能・形式は変更されません。

| 既存機能 | 影響 |
|---|---|
| `GET /api/comments/delta` | 従来のカーソル方式を維持 |
| `GET /health` | 変更なし |
| `GET /api/status` | 変更なし |
| `POST /api/start` | 変更なし |
| `POST /api/e2e/start` | 変更なし |
| `POST /api/stop` | 変更なし |
| 管理画面 | 変更なし |
| R2 `comments.json` | 形式・出力を維持 |
| R2 `status.json` | 形式・出力を維持 |
| `streams/{videoId}/comments.json` | 形式・出力を維持 |

固定URL版は既存のDurable Object SQLiteイベントログを読み取るだけです。API取得による書き込み、カーソル消費、YouTube API呼び出しは発生しません。

# 本番確認

固定URL版:

```bash
curl -i \
  'https://blmf-chat-relay.tsubasa-azumagakito.workers.dev/api/comments/delta/simple'
```

カーソル版:

```bash
curl -i \
  'https://blmf-chat-relay.tsubasa-azumagakito.workers.dev/api/comments/delta'
```

HTTP 404になる場合は、Cloudflare WorkerがAPI追加前のコミットを実行している可能性があります。最新の `main` をデプロイしてから確認してください。

# 関連情報

- Issue #3：カーソル方式の差分コメント取得API
- PR #5：カーソル方式の実装
- Issue #6：固定URLで取得できる単純差分API
- リポジトリ内詳細資料：`docs/delta-api.md`、`docs/simple-delta-api.md`

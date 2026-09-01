# 固定URL単純差分取得 API

クエリパラメータを動的に変更できないクライアント向けに、固定URLだけで利用できる差分取得APIを提供する。

既存のカーソル方式 `GET /api/comments/delta` は変更せず、ページングや厳密な再取得が必要なクライアント向けとして残す。

## エンドポイント

```http
GET /api/comments/delta/simple
```

本番URL:

```text
https://blmf-chat-relay.tsubasa-azumagakito.workers.dev/api/comments/delta/simple
```

クエリパラメータ、リクエスト本文、認証は不要。同じURLを定期的に取得する。

リレー停止中で現在の実行に差分イベントがない場合は、R2の既存 `comments.json` から最新50件を初期イベントとして返す。このとき `streamId` は `snapshot` となる。ライブのリレーが開始すると新しい `streamId` に切り替わり、以後は実際のライブ差分イベントを返す。

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
      "created_at": "2026-08-31T01:23:45.000Z"
    }
  ],
  "windowStartCursor": 125,
  "latestCursor": 125,
  "truncated": false,
  "windowSize": 50
}
```

| フィールド | 説明 |
|---|---|
| `streamId` | 現在のリレー実行ID。配信・リレー実行が切り替わると変わる |
| `events` | 現在の実行に属する直近最大50件のイベント。`seq` 昇順 |
| `windowStartCursor` | 応答内で最も古いイベントの `seq`。イベントがなければ0 |
| `latestCursor` | 応答内で最も新しいイベントの `seq`。イベントがなければ0 |
| `truncated` | 現在の実行に50件を超えるイベントがあり、古いイベントを省略した場合は `true` |
| `windowSize` | サーバーが返す最大イベント件数。現在は50 |

## クライアント処理

クライアントはURLを変更する必要はない。ローカルには次の2値だけを保持する。

- 最後に確認した `streamId`
- 最後に適用した `seq`

```text
streamId = null
lastSeq = 0

10秒ごとに固定URLをGET:
  response = GET /api/comments/delta/simple

  初回:
    streamId = response.streamId
    lastSeq = response.windowStartCursor - 1

  response.streamId != streamId:
    ローカルのコメント状態をクリア
    streamId = response.streamId
    lastSeq = response.windowStartCursor - 1

  lastSeq + 1 < response.windowStartCursor:
    50件窓から取りこぼした状態
    必要な警告を記録
    lastSeq = response.windowStartCursor - 1

  eventsのうち seq > lastSeq のものだけをseq昇順に適用
    upsert -> idをキーに追加または置換
    delete -> idをキーに削除
  lastSeq = response.latestCursor
```

初回、`streamId` の変更時、取りこぼし検出時も、応答に含まれる `events` は適用する。表示側を最新20件程度の固定サイズに保つことで、復帰時に表示が過剰に増えることを防ぐ。

## 再取得と複数クライアント

このAPIは取得時にサーバー側カーソルを進めない。同じ状態で同じURLを再取得すると同じ応答になる。

そのため次の問題が発生しない。

- HTTP応答を受信できなかったことでイベントが消費される
- 動作確認のためブラウザで開いたことで本番クライアント分のイベントが消える
- 複数クライアントのうち最初の1台だけがイベントを取得する

重複排除はクライアント側で `streamId` と `seq` を使って行う。

## 50件窓の制約

固定URLかつサーバー側でクライアント識別を行わないため、応答は直近50件のローリングウィンドウとなる。

クライアントの停止中や通信断の間に50件を超えるイベントが発生すると、古いイベントは取得できない。次の条件で検出できる。

```text
lastSeq + 1 < windowStartCursor
```

すべてのイベントを厳密に回収する必要があるクライアントは、既存のカーソルAPIを使用する。

```http
GET /api/comments/delta?streamId=<streamId>&after=<cursor>&limit=50
```

## イベント種別

### `upsert`

新規コメントまたは同じコメントIDの更新。`id` をキーに追加・置換する。

### `delete`

YouTube上のコメント削除または投稿者BANによる削除。`id` をキーに削除する。投稿者BANでは保存中の各コメントについて `delete` が発生する。

## HTTP・CORS

- 認証不要
- `GET` と `OPTIONS` に対応
- `Access-Control-Allow-Origin: *`
- `GET` / `OPTIONS` 以外は HTTP 405
- `Cache-Control: no-store`

## 既存機能への影響

次の機能・形式は変更しない。

- `GET /api/comments/delta` のカーソル方式
- `GET /health`
- `GET /api/status`
- `POST /api/start`
- `POST /api/e2e/start`
- `POST /api/stop`
- 管理画面
- R2 `comments.json`
- R2 `status.json`
- `streams/{videoId}/comments.json`

固定URL版は既存の `comment_events` テーブルを読み取るだけであり、取得による書き込みやイベント消費は行わない。

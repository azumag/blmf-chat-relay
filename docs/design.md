# BLMF Chat Relay 設計

## 1. 目的

YouTube の配信IDを運用者が都度調べることなく、チャンネル指定だけで現在のライブ配信を発見し、コメントの最新スナップショットを Cloudflare R2 へ公開する。

運用条件は「配信中だけ使う」ことを前提とし、開始・停止が簡単で、停止中には YouTube API を呼ばないことを重視する。

## 2. コンポーネント

### Worker エントリポイント

責務:

- 管理画面、CSS、JavaScriptの配信
- 開始・停止・状態取得 API
- Bearer トークン認証
- 単一 Durable Object への RPC
- セキュリティヘッダーと構造化エラーログ

### Durable Object `YouTubeChatRelay`

責務:

- リレー状態の永続化
- YouTube API 呼び出しのスケジューリング
- コメントの重複排除
- R2 スナップショットの生成
- 配信終了・エラー・手動停止の状態遷移

全イベントをインスタンス内の Promise チェーンで直列化する。YouTube や R2 の外部 I/O 中に開始・停止処理が割り込んで、古い実行が新しい `comments.json` を上書きする競合を避けるためである。

### R2

- `comments.json`: 現在または最後に停止した配信のコメント配列
- `status.json`: 公開状態
- `streams/{videoId}/comments.json`: 配信別スナップショット

R2 へは Worker 内から REST API を呼ばず、R2 binding を使用する。

## 3. 状態

| phase | 意味 |
|---|---|
| `stopped` | 無効。Alarmなし、YouTube API呼び出しなし |
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

`runId` は開始単位で生成し、コメントテーブルのパーティションキーとして使う。前回の配信データと新しい開始処理を混同しない。

## 4. SQLite スキーマ

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
```

YouTube のメッセージIDを使って `UPSERT` し、同じページを再取得しても重複しない。

## 5. チャンネルからライブチャットまでの解決

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
   - `activeLiveChatId` がある、終了していない動画を選ぶ
4. `liveChatMessages.list`
   - `part=id,snippet,authorDetails`
   - `nextPageToken` を次回へ保存
   - `pollingIntervalMillis` に従って次回 Alarm を設定

同時に複数のライブが見つかった場合は、`actualStartTime` が最も新しいものを採用する。

## 6. コメント変換

R2へ出す公開形式は次の3項目だけとする。

```ts
interface ExportedComment {
  name: string;
  message: string;
  created_at: string;
}
```

内部では重複排除とモデレーション反映のため、YouTube のメッセージIDと投稿者チャンネルIDも保持する。

変換規則:

- `hasDisplayContent` があり、表示名・本文・投稿時刻が揃うイベントを保存
- `tombstone` または削除イベントは対象メッセージを削除
- `userBannedEvent` は対象投稿者の当該配信内コメントを削除
- `chatEndedEvent` または `offlineAt` を受けたら最終保存して自動停止
- 表示内容のないモード変更イベント等は無視

## 7. スケジューリング

Durable Object の Alarm は1個だけ設定できるため、状態に応じて次のどちらかを予約する。

- `waiting`: `DISCOVERY_INTERVAL_SECONDS` 後に配信再検索
- `running`: YouTube 応答の `pollingIntervalMillis` 後にコメント再取得

開始時は `Date.now()` で即時 Alarm を設定する。停止時は Alarm を削除する。

## 8. R2 書き込み

通常は `R2_FLUSH_INTERVAL_SECONDS` ごとに以下を書き込む。

1. 最新 `comments.json`
2. `videoId` がある場合は配信別アーカイブ
3. 上記が成功した後に `status.json`

コメント本体と配信別アーカイブは並列化し、状態JSONは最後に書く。これにより `status.json` が成功を示しているのにコメント本体だけが古い、という部分成功を避ける。

次の場合は間隔を待たず強制反映する。

- 新規開始
- 配信を発見
- 配信未検出へ遷移
- 手動停止
- 配信終了
- エラー状態へ遷移

`Cache-Control: no-store, max-age=0, must-revalidate` を設定し、R2カスタムドメイン側で古い JSON が残りにくいようにする。

## 9. エラー処理

### 自動停止するエラー

- APIキー不正
- YouTube Data API 未有効
- クォータ枯渇
- 権限不足
- ライブチャット無効
- チャンネル不正

### 再試行するエラー

- ネットワークエラー
- YouTube 5xx
- `rateLimitExceeded`
- その他一時的エラー

2秒から最大5分まで指数バックオフする。

### 特別処理

- `pageTokenInvalid`: ページトークンを破棄し、2秒後に最新ページから再開
- `liveChatEnded` / `liveChatNotFound`: 配信終了扱いで最終保存して停止
- R2書き込み失敗: コメント取得中は次回ポーリング時に再試行する。停止後の最終反映失敗は、YouTube APIを呼ばないR2専用Alarmを30秒後に設定して再試行する

## 10. セキュリティ

- `YOUTUBE_API_KEY` と `ADMIN_TOKEN` は Secret
- 開始・停止は Bearer 認証
- トークン比較は Web Crypto の HMAC verify を使用
- 状態取得は公開。公開R2に含まれる情報と同等のため
- 管理画面は厳格な CSP を設定し、外部スクリプトを読み込まない
- APIレスポンスと管理画面は `no-store`
- ログに管理トークン、APIキー、コメント本文、視聴者名を出さない

管理面を独自ドメインに割り当てる場合は Cloudflare Access を追加する。

## 11. 整合性

外部 I/O を含む操作を直列化し、停止・再開始・Alarm の同時実行を防ぐ。さらに `runId` を各処理で検証し、古い実行単位の結果を現在状態へ適用しない。

R2 書き込みは冪等で、同じオブジェクトへ完全なスナップショットを書き直す。途中失敗した場合も次回の完全書き込みで収束する。

## 12. 制約と将来案

### 現行制約

- リレー開始以前のチャット全履歴を保証しない
- 単一JSON配列のため、高コメント量ではR2転送量が増える
- YouTube の検索専用クォータを使うため、配信待機の常時稼働を想定しない
- 単一チャンネル・単一同時配信を対象とする

### 将来案

- `liveChatMessages.streamList` を利用したストリーミング取得の検証
- `comments.json` 互換出力を維持しつつ、内部をチャンク化
- 複数チャンネル対応（チャンネルごとに Durable Object を分割）
- Cloudflare Access 前提の管理ドメイン
- GitHub Actions によるデプロイ
- R2ライフサイクルルールによる古い配信アーカイブ整理

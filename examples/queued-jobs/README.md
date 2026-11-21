# Queued jobs

Queueで受けたジョブをDurable Objectで調整し、D1に設定・履歴を保存する実行例です。RPC validatorによる投入前検証、重複排除、失敗時の再試行を含みます。

`app/Main.hs`はイベントexport、`src/QueuedJobs/`はAPI・ジョブ・Queue処理、`worker/`はWorker入口とRPC validatorです。`test/Support/`の障害注入は公開reactorから分離します。

ルートで`pnpm install --frozen-lockfile`、`just test-queued-jobs`を実行します。`scripts/build.sh`は公開reactorとfixture用reactorの両方を生成します。ローカル検証のD1とQueueはWranglerの一時状態を使います。

## 一括処理依頼と永続設定

`POST /jobs`へ`{"jobs":[{"identifier":"job-1","payload":"example"}]}`を送ると、D1の処理設定を型付きdecoderで検査し、別Workerの`JobsValidator`へService Binding RPCで入力検証を依頼します。受理した依頼はQueueへ一括送信します。consumerはDO RPCでHaskell処理を呼び出し、DO SQLの同一トランザクションで状態と処理済み記録を保存してからackします。失敗時はretryし、同じ識別子・内容の再配送で更新数は増えません。

`GET /jobs/<identifier>`で処理結果を取得できます。識別子は配送単位ではなく、アプリが再送時にも保持する値です。D1の`processing_settings`は有効フラグ・件数上限・0〜1の評価値・任意説明・binary添付を持ち、bool/bounded integer/refine/double/nullable/blob decoderを利用します。不正な保存値でQueueへ送信しません。

`POST /jobs/settings`はDOのKV形式storageに設定と変更履歴を原子的に保存します。`GET /jobs/settings/history`は新しい順に最大3件を返し、更新時に古い履歴を削除します。これはD1の受付設定とは別のDO設定例です。削除途中で失敗しても、次の更新で清掃を再開できます。

入力不正は400、対象なしは404、設定により操作できない場合は409です。想定外の障害は機密情報を含まない500へ変換します。業務例外の変換に`mapExceptionsToServerError`を利用します。


## Queue転送形式・診断・advisory marker

`POST /queue-examples/<transport>`は通常のJob JSONを受け付けます。`bytes-single`・`bytes-batch`はbytes便利関数、`text`は明示的content type、`bytes`・`v8`は各body constructorを使用します。`message-delay`・`batch-delay`は1秒の送信遅延です。受信はHaskellの型付きJSON入口を通り、DO保存後にackします。

`GET /queue-examples/diagnostics/metrics`は実Queueのmetrics機能を診断します。対応時のみ実値を返し、未対応は`status: "unsupported", metrics: null`、その他の失敗は`status: "failed", metrics: null`です。未対応をゼロ件と解釈しません。

`POST /queue-examples/advisory/check`へJSON文字列の識別子を渡すと、KVを使う`queueDedupCheck`の順次照会例を実行します。初回は`firstSeen: true`、保存済みなら`false`です。このread-then-writeは原子的ではなく、並行処理やKVの整合性特性に対してexactly-onceを保証しません。既存APIはTTLを設定しないためmarkerは期限切れせず、保持期間と削除は利用側の責任です。本番jobsのDO SQLによる重複防止とは別用途です。

`test/Support/QueueContracts.hs`と`queue-contracts.ts`の合成境界テストは、独自metricsの実値保持・欠如・不正値拒否、Haskellのbatch ack/retry、既定JSON入口を検査します。これらは実WASMを通しますが、ネイティブQueueがmetricsに対応する証拠とは分けています。


validatorは`wrangler.validator.jsonc`、Queue・DO・D1は`wrangler.jsonc`で構成します。テストはvalidatorと本体を同じpersist先で起動します。

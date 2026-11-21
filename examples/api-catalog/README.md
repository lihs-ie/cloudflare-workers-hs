# 機能別の実行例

KV・Cache・R2・型付きClient・Socket・設定・ログをHaskellから操作する例です。デプロイ構成の基礎は[minimal](../minimal/README.md)、認証・D1・Queue・Scheduled・DOを組み合わせた実用例は[UrlShortener](../url-shortener/README.md)、全体の対応は[機能一覧](../features.md)を参照してください。

## 配置

- `src/ApiCatalog/API.hs`: 1つのNamedRoutesルートAPI。
- `src/ApiCatalog/Application.hs`: APIハンドラの配線と基本のKV・Cache・Stream操作。
- `src/ApiCatalog/Storage.hs`: KVの型別取得・一覧・削除・失効、名前付きCacheの失効。
- `src/ApiCatalog/Database.hs`: prepared statementと型付きQueryによる冪等なcatalog更新。
- `src/ApiCatalog/R2.hs`: 条件付き取得・範囲取得・multipart。
- `src/ApiCatalog/Client.hs`: 型付きService Bindingと失敗・再試行。
- `src/ApiCatalog/SocketExamples.hs`: TCP/TLS/StartTLSの接続と後片付け。
- `src/ApiCatalog/Logging.hs`: diagnostics・warnings・errors-onlyの構造化ログ設定。
- `src/ApiCatalog/Configuration.hs`: 型付きVar/Secretと秘密を出さないログ。
- `app/Main.hs`: fetch・TailのHaskell入口。
- `worker/`: TypeScript入口・WASI初期化・生成WASM/JSFFI。
- `test/integration/`: 振る舞い別テスト。`*.cases.mts`は入口から1回だけ登録。
- `test/Support/`: 起動、通信障害、TLS証明書等の固定入力。

`library-guide`は同じHaskellのNamedRoutesハンドラを別Workerとして起動したService Binding先です。`library-tail`はそのイベントを受け取る専用Workerです。

## 全操作を試す

リポジトリルートで実行します。

```sh
just setup-js
just test-api-catalog
# Docker内のLinux workerdを使う場合（minimal/UrlShortenerも実行）
just test-docker
```

共通コマンドはWASMをビルドし、`test/integration/*.spec.mts`をすべて実行します。生成物のソース・WASM・JSFFIのSHA-256を検査し、古い成果物を拒否します。テストは独立した一時状態を使用し、終了時にプロセスと状態を片付け、ログを`artifacts/testing/`へ保存します。

## 主な操作

| HTTP | 用途 |
| --- | --- |
| `POST /settings` | KVのTTL・metadata・一括取得・一覧 |
| `POST /storage/metadata` | KV一括metadata、cursorによる分割取得、削除 |
| `POST /storage/formats` | KVのJSON・バイナリ・Stream |
| `POST /storage/json-metadata` | JSONの単体・一括metadata取得と絶対期限 |
| `POST /database/catalog` | パラメータ化prepared statement、型付き読取り、native実行metadata |
| `POST /storage/ttl-write` / `ttl-read` | 最小60秒TTLの設定と実時間での失効 |
| `GET /guide` / `DELETE /guide` | Cache miss/hit/削除 |
| `POST /storage/cache-write` / `cache-read` | 名前付きCacheの時間経過による失効 |
| `POST /r2/listing` | prefix・cursor・metadata、一括削除と不存在確認 |
| `POST /r2/conditional` | ETagとHTTPヘッダーによる条件付き取得 |
| `POST /r2/range` | offset・length・suffix、範囲外の拒否 |
| `POST /r2/multipart` | 5 MiB＋バイナリパートを送信、upload identifierから再開し完成 |
| `POST /r2/abort` / `retry-complete` | 中止後の拒否、失敗したcompleteの再試行 |
| `POST /r2/readers` / `write-options` | 各body readerと条件付き更新、Blob・既知長Stream・空body保存 |
| `POST /r2/checksums` / `browse-options` | 5種類のchecksum、HTTP metadata、delimiter・startAfter・UTC条件 |
| `GET /service` | 別Haskell Workerへの型付きGET・POST・409 |
| `GET /client-policy` | 型付きPUTと失敗分類（テストでは通信障害・不正JSONを注入） |
| `GET /tcp-structured` | SocketAddressRecordと検証済みportによるTCP接続、peer EOF確認 |
| `POST /logging/:policy` | diagnostics・warnings・errors-onlyのログレベルとsampling設定 |
| `GET /tcp` / `/tls` / `/starttls` | 運用者が設定した接続先との送受信 |
| `GET /stream` | 空chunkを含むproducerからEOFまで読み取る |
| `GET /configuration` | Var/Secretが設定されていることを値を公開せず確認 |

R2の[非最終パートは5 MiB以上](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)です。KVの[TTLは最小60秒](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)のため、失効テストには約1分かかります。

## 手動で起動する

`wrangler.jsonc`・`wrangler.guide.jsonc`・`wrangler.tail.jsonc`が3つのWorkerに対応します。ローカルの`.dev.vars`へ`EXAMPLE_SECRET`を設定してください。`EXAMPLE_MODE`は設定ファイルにあります。リモートで利用する場合は各WorkerのSecretと実際のBindingを用意します。

```sh
bash examples/api-catalog/scripts/build.sh
cd examples/api-catalog
../../node_modules/.bin/wrangler dev --local \
  --config wrangler.jsonc --config wrangler.guide.jsonc --config wrangler.tail.jsonc
```

別ターミナルから`curl http://localhost:8787/health`などで呼び出します。Socketは設定変数`TCP_ADDRESS`・`TLS_ADDRESS`・`STARTTLS_ADDRESS`に管理下のサービスを指定します。クライアントから任意の接続先を受け付けません。

自動テストは動的ポートのTCP/TLS/StartTLSサーバーを立てます。テスト専用CAを`NODE_EXTRA_CA_CERTS`でローカルworkerdへ信頼させ、証明書検証を有効にしたまま通信します。OpenSSLでテストごとに専用CAと有効期間365日のサーバー証明書を発行し、終了時に鍵と証明書を削除します。固定の秘密鍵はリポジトリに置きません。

Tailは固定形状の入力変換テストと、`tail_consumers`を使ったローカルworkerdの実配信テストを区別します。これはCloudflare本番環境へデプロイした証拠ではありません。

この例には管理認証を付けていません。ローカル学習用の操作をアプリへ移す際の認証・認可の組み込み方はUrlShortenerを参照してください。

## 宣言的HTTP情報とClient設定

`GET /guide`は`CacheControlled`で`public, max-age=60`を宣言します。`GET /diagnostics/edge`は`EdgeDataCenter`からcoloを取得し、取得できない環境では`null`を返します。診断応答は`no-store`です。

`GET /client-options?timeout=1000&retries=2&delay=10&mode=success`は、運用者が指定した`CLIENT_ORIGIN`へのHTTP GETで`fetchWithOptions`を使います。timeoutは各試行1〜30000 ms、retryは0〜3回、初期待機は0〜1000 msです。不正値は通信開始前に400とします。既定値は10000 ms・2回・250 ms。`mode`は`success`・`slow`・`retry`の固定path選択のみで、リクエストから任意URLを指定できません。テストは管理下のHTTP serverで実際の中断・遅延を再現します。Service Binding fetchにはこのtimeoutを適用しません。

## 添付ファイルとSSE-C

`PUT /attachments/<identifier>`は最大1 MiBのbinaryを保存し、`GET`はR2に保存したHTTP metadataを`r2ObjectWriteHttpMetadata`で応答へ反映します。Content-Type、Content-Disposition、Cache-Control、ETagを保持し、ダウンロードは`private, no-store`です。

両リクエストで`X-Attachment-Encryption: sse-c`を明示すると、`ATTACHMENT_SSEC_KEY` Secretを使用します。鍵は32 UTF-8 bytesで、未設定・不正は503、R2障害は502です。暗号化失敗を平文保存で補いません。鍵を応答・ログへ出さず、平文と暗号化オブジェクトの名前空間も分離します。固定鍵はテスト専用で、運用時は適切に生成したSecretを設定します。このexampleのHTTP入口自体には利用者認証を追加していません。

## 本番入口とテスト入口

本番WASMはfetchとTailをexportします。Stream障害・Response変換・設定異常の内部検査は`test/Support/Main.hs`の専用実行形式`api-catalog-fixtures`へ分離しました。JSFFI/WASMも別成果物になり、本番入口からfixtureをimportしません。

本体・guide・Tailの3つをまとめて起動します。ジョブとQueueの構成は[queued-jobs](../queued-jobs/README.md)へ分離しています。本番用のD1識別子・Service・Secretは利用環境に合わせて設定してください。現在のローカルR2はSSE-Cを適用せず、別鍵・鍵なしでも取得できるため、ローカルの往復成功は暗号化の証拠になりません。テストではこの制限を診断し、対応環境での別鍵拒否は未検証として区別します。

## アーカイブの暗号化とstorage class

`src/ApiCatalog/Archives.hs`はNamedRoutesで用途別入口を定義し、
`R2Archive.hs`の処理を呼び出します。

- `POST /archives/encrypted/<identifier>`: `ATTACHMENT_SSEC_KEY` Secretを検証し、5 MiB＋3 bytesのアーカイブをmultipartで保存します。作成時と再開後を含む各partで同じ鍵を指定し、転送失敗時はabortします。
- `GET /archives/encrypted/<identifier>`: 同じSecretで保存内容を読みます。
- `POST /archives/infrequent/<identifier>`: `InfrequentAccess`を明示して監査記録を保存します。
- `GET /archives/infrequent/<identifier>`: 保存した監査記録を取得します。

POSTのJSONには実測size、実際に返されたstorageClass、鍵metadataの有無を返します。
鍵そのものは返しません。完成済みオブジェクトは保持され、利用側が保持期限・削除を管理します。
ローカルテストだけが専用cleanup fixtureを使って削除します。

[Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)と
生成された`R2UploadPartOptions`に従い、uploadPartの第3引数は`{ ssecKey }`です。
[SSE-C紹介例](https://developers.cloudflare.com/r2/examples/ssec/)の鍵直接渡しとは記述が異なります。
実装は現在のAPI reference・生成型・[workerd実装](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/r2-multipart.h)と整合するoptions形式を維持します。

現在のローカルR2はmultipartでも鍵を無視し、InfrequentAccessも保持しません。
正常な転送と鍵の引数形はテストしますが、暗号化・別鍵拒否・storage classの課金／保持保証は未検証です。
[InfrequentAccess](https://developers.cloudflare.com/r2/buckets/storage-classes/)の本番利用には取得料金と最低保管期間があります。
この変更ではクラウド操作を実行しません。

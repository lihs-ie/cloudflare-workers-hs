# ライブラリ機能と実行例

公開APIの未例示機能と追加計画は[活用棚卸し](../docs/audits/example-full-use.md)を参照してください。この表は主要機能の対応表であり、公開API全体の網羅を示すものではありません。

この一覧はQuickstartの[活用計画](../docs/specs/quickstart-full-library-plan.md)に対応します。Cloudflare製品全体ではなく、このリポジトリが提供するHaskellライブラリの利用例です。

HTTP APIはアプリごとに1つの`NamedRoutes`ルートを持ちます。Queue・Scheduled・DO・TailはHTTP APIとは別のイベント入口です。

| 機能 | 使用場所 | 検証する振る舞い |
| --- | --- | --- |
| HTTP / URL / Headers / NamedRoutes | [minimal](minimal/src/Minimal)、[4つのHTTPアプリ](quickstart/apps) | JSON、404/405、Capture・Query・Header・ReqBody、認証、302、応答Headers |
| Access / SubtleCrypto | [Quickstart Runtime](quickstart/src/Quickstart/Runtime.hs) | RS256署名、期限、iss/aud、管理者別冪等性、認証付きダウンロード |
| D1 / 型付きQuery | [共有インフラ](quickstart/packages/infrastructure)、[migration](quickstart/migrations) | URL・集計・固定CSVスナップショット、原子更新、ページ分割、パラメータ化実行・型付き行デコード |
| Queue / 型付きconsumer | [バックグラウンド処理](quickstart/workers) | 集計重複排除、CSV生成、DLQ保存・明示再投入、JSONデコード・成功ack・失敗retry |
| R2 | [CSV生成](quickstart/workers/export-generation)、[独立操作](library-examples/src/LibraryExamples/R2.hs) | 条件付き書込/取得、範囲・suffix、metadata・head・list・delete、multipart再開/完了/中止 |
| Static Assets | [画面とAPI](static-assets/README.md) | Haskell Assets Binding、予約パスによるAPI優先、HTML/JS/CSS、HEAD・ETag・404 |
| WebSocket / DO SQL | [リアルタイム例](realtime/README.md) | Hibernation対応接続、SQL履歴、バイナリ・close、同期SQL batch |
| Workflows | [永続ジョブ](workflows/README.md) | ステップ再試行、待機、イベント、完了・失敗、Haskell業務処理 |
| Streaming | [独立例](library-examples/src/LibraryExamples/Application.hs)、CSV生成/取得 | 空chunk、binary、EOF、上限、cancel、reader解放、固定長ストリーム |
| Scheduled | [maintenance](quickstart/workers/maintenance) | 期限清掃、100件単位、R2途中失敗後の再開、未送信ジョブの再送 |
| Durable Objects | [export-coordinator](quickstart/workers/export-coordinator) | 同時実行数、永続lease、tokenによる旧処理拒否、Alarm回復 |
| KV | [Storage](library-examples/src/LibraryExamples/Storage.hs)、[表示設定](library-examples/src/LibraryExamples/Application.hs) | TTL、実時間の失効、metadata、一括取得、cursor、JSON/binary/stream、削除 |
| Cache / CacheControl | [Storage](library-examples/src/LibraryExamples/Storage.hs)、[公開ガイド](library-examples/src/LibraryExamples/Application.hs) | default/named cache、miss/hit、失効、明示削除 |
| Service Binding / Client | [Client](library-examples/src/LibraryExamples/Client.hs) | 別Haskell WorkerへのGET/POST/PUT、409、DecodeFailure、通信障害、上限付きretry |
| Socket | [SocketEndpoints](library-examples/src/LibraryExamples/SocketExamples.hs) | 管理下TCP、TLS、StartTLS、送受信、切断、接続拒否 |
| Env / Var / Secret / Middleware / Observability | [Configuration](library-examples/src/LibraryExamples/Configuration.hs) | 型付き設定、必須設定欠落、秘密の非出力、識別子・処理時間ログ、例外秘匿 |
| Tail | [Main](library-examples/app/Main.hs)、[テスト入口](library-examples/test/Support/entry.ts) | イベントの変換と、別Workerへの配信 |
| Reactor / Bundle / JSFFI | [最小例](minimal/README.md)、各例の`worker/`とビルドスクリプト | 公式npm runtimeによるWASI初期化・イベント接続、foreign export、実WASM、生成物の鮮度検査 |

## 実行と検証の範囲

- `just test-minimal`: 最小のHTTP Worker。
- `just test-dev`: Quickstartの本番WASMを実`wrangler dev`で接続。
- `just test-library-examples`: 機能別の全`*.spec.mjs`を列挙して実行。KV失効は実際に60秒待つ。
- `just test-integration`: 実WASM境界とQuickstartの復旧・並行性を含む本番統合テスト。
- `just test-static-assets` / `just test-realtime` / `just test-workflows`: 新しい用途別実行例。
- `just test-docker`: 6つの例をDocker内で実行。

通信障害の再現はテスト専用Service Bindingラッパーで行い、成功した再試行は実際の別Haskell Workerへ到達します。クライアント例は同じ本文と冪等性キーを保持することを検証し、更新の重複防止自体はQuickstartのD1による管理APIで検証します。

ローカルのKV・Cache検証は、グローバルな伝播時間の証明ではありません。KVのTTL最小60秒は[公式仕様](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)に従います。テスト専用証明書・秘密・障害注入は`test/Support/`へ隔離します。

これらの利用例の成功と、全自作コードの行・式・分岐100%は別の判定です。全体のカバレッジとCIの実測状況は[検証台帳](../docs/specs/testing-modernization-status.md)を参照してください。

高水準APIへの抽出方針は[設計](../docs/specs/high-level-library-api.md)を参照してください。JS依存はリポジトリルートで`just setup-js`により導入します。

## 棚卸し後に追加した利用例

- Quickstart: `ZeroTrust`による認証とclaims注入、明示的Access verifier設定。
- minimal: `genericServeWithContext`を使うNamedRoutes入口。
- library-examples: RPC・Queue一括送信・DO SQL重複防止、D1各種decoder、DO KV設定履歴、宣言的cache/colo、HTTP timeout/retry、R2 metadata/SSE-C。
- workflows: 承認後のUTC予約実行と、予定時刻前に業務書込みをしない検証。
- 全example: pnpm workspace経由の公開npm package import。独立したpack consumer検証は`pnpm test:package`。
- Library/Workflowのテスト用exportを専用WASMへ分離。

実装と最終検証の結果は[検証台帳](../docs/specs/testing-modernization-status.md)に記録します。

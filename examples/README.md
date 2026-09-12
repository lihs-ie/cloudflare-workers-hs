# HaskellをWorkersで動かす実行例

目的に応じて次の順に読んでください。API定義はすべて`NamedRoutes`方式です。

| ディレクトリ | 読む目的 | 実行 |
| --- | --- | --- |
| [minimal/](minimal/README.md) | デプロイに必要なファイルとHaskell→WASM→Workerの接続を理解する | `just test-minimal` |
| [quickstart/](quickstart/README.md) | 認証付きURL短縮アプリを、HTTP・Queue・Scheduled・DOへ分割する | `just test-dev` |
| [static-assets/](static-assets/README.md) | 静的画面とHaskell APIを1つのWorkerで配信する | `just test-static-assets` |
| [realtime/](realtime/README.md) | WebSocketとDO SQLで履歴のあるチャットを作る | `just test-realtime` |
| [workflows/](workflows/README.md) | 再試行・待機・イベント受信を伴う永続ジョブを作る | `just test-workflows` |
| [library-examples/](library-examples/README.md) | KV・Cache・R2・Client・Socket等の操作を個別に試す | `just test-library-examples` |

これら6つの例をDocker内の実`wrangler dev`で検証する入口は`just test-docker`です。HaskellのWASMビルドはホストで行い、Dockerでは生成物の鮮度を検査してLinuxのworkerdで実行します。

## ファイルの役割

| 名前 | 内容 |
| --- | --- |
| `app/Main.hs` | Haskellのイベント入口、JavaScriptへのexport |
| `src/` | NamedRoutes APIとハンドラ |
| `worker/` | TypeScriptの入口・WASI初期化、生成WASM・JSFFI |
| `scripts/build.sh` | WASMとJSFFIの生成（Quickstartは`build-wasm.sh`） |
| `wrangler*.jsonc` | Workerごとの名前・入口・Binding・イベント設定 |
| `test/integration/` | 実ランタイムを使う振る舞いテスト |
| `test/Support/` | 起動・固定入力・通信障害注入などのテスト補助 |

Quickstartだけはアプリが複数あるため、`apps/`に4つのHTTPアプリ、`workers/`にバックグラウンド処理、`packages/`に共有ドメインとD1アダプタを置きます。`app/`は実行ファイルの入口、`apps/`はアプリケーションの実装という違いがあります。

Cabalの依存関係とコンパイラ設定はルートの`cabal.project`・`cabal-wasm.project`、Wrangler等の開発用JavaScript依存は`quickstart/package.json`、ロックファイルとpnpm workspace設定はリポジトリルートに集約しています。各exampleは、pnpm catalogで固定した公開Gitリポジトリ版`@cloudflare-workers-hs/runtime`を利用します。初回はリポジトリルートで`just setup-js`を実行してください。独立プロジェクトへコピーする場合の変更点は[minimalの説明](minimal/README.md#独立したプロジェクトにする場合)を参照してください。

各機能の実装先・検証先は[機能一覧](features.md)にまとめます。テスト結果はルートの`artifacts/testing/`に保存します。

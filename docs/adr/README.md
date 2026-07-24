# Architecture Decision Records (ADR)

このディレクトリは `cloudflare-workers-hs` —— Haskell の [Servant](https://www.servant.dev/) を
Cloudflare Workers (workerd) 上で不自由なく実運用するためのライブラリ —— における
アーキテクチャ上の意思決定を記録する。

## ADR とは

ADR (Architecture Decision Record) は、プロジェクトにとって重要な意思決定 1 件を、
その背景・検討した選択肢・決定・結果とともに 1 ファイルに残す軽量な記録形式である。
本リポジトリでは [MADR](https://adr.github.io/madr/) 形式を日本語化した
[`template.md`](./template.md) を雛形として用いる。

## 命名規則

- ファイル名: `NNNN-kebab-case-title.md`（4 桁ゼロ埋めの連番）
- タイトル: 「<動詞> <対象>」の形式で、決定内容が一目で分かるようにする

## ステータス

| ステータス | 意味 |
| --- | --- |
| 提案中 | レビュー中。まだ確定していない |
| 承認 | 採用が確定し、実装の根拠となる |
| 却下 | 検討の結果、採用しないと決めた |
| 非推奨 | かつて承認されたが、もう推奨しない |
| 置換 | 別の ADR で置き換えられた（`置換(→ ADR-XXXX)`） |

これらの ADR は [調査メモ](../research/feasibility-servant-on-cloudflare-workers.md)（多角的 Web 調査 +
一次情報 + 敵対的検証）を根拠とする。

## プロジェクト横断方針

- **フォーク禁止・全て自前実装**: `servant-server` をフォーク/依存せず、サーバ解釈系・バインディング・
  クライアントを自前実装する。`servant`/`servant-client-core` の純コア DSL は再利用する（[ADR-0006](./0006-servant-execution-engine.md)）。
  konn 各ライブラリ（`servant-cloudflare-workers` / `Steward` / `ghc-wasm-earthly`）は設計参照のみ。
- **認証は Cloudflare Zero Trust を最大限活用**する（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）。

## 索引

<!-- ADR を追加したらここに 1 行追記する -->

| # | タイトル | ステータス |
| --- | --- | --- |
| [0001](./0001-ghc-native-wasm-backend.md) | コンパイルツールチェーンに GHC ネイティブ WebAssembly バックエンドを採用する | 承認 |
| [0002](./0002-wasi-reactor-workerd-integration.md) | WASI reactor モデルで workerd にモジュールを組み込む | 承認 |
| [0003](./0003-jsffi-cloudflare-bindings-layer.md) | Cloudflare ランタイム API バインディングを JSFFI で自前実装する | 承認 |
| [0004](./0004-fetch-entrypoint-request-lifecycle.md) | fetch ハンドラを foreign export で公開しリクエストごとのライフサイクルを定義する | 承認 |
| [0005](./0005-http-layer-no-wai.md) | HTTP 層は WAI を介さず Cloudflare Request/Response を直接扱う | 承認 |
| [0006](./0006-servant-execution-engine.md) | Servant 互換の型駆動ルーティング/サーバ解釈系を自前実装する | 承認 |
| [0007](./0007-streaming-readablestream.md) | リクエスト/レスポンス本文は ReadableStream を素通しでストリーミングする | 承認 |
| [0008](./0008-cloudflare-platform-bindings.md) | Cloudflare プラットフォームバインディングを env 経由でハンドラ文脈に供給する | 承認 |
| [0009](./0009-auth-zero-trust-subtlecrypto.md) | 認証は Cloudflare Zero Trust (Access) を一級に活用し、暗号は SubtleCrypto に委譲する | 承認 |
| [0010](./0010-websockets-durable-objects.md) | WebSocket は Durable Objects を介して実現する | 承認 |
| [0011](./0011-outbound-http-fetch-backend.md) | 送信 HTTP は fetch をバックエンドとする servant-client 解釈系を自前実装する | 承認 |
| [0012](./0012-middleware-equivalents.md) | ミドルウェア相当機能は Servant レベルの変換と Cloudflare エッジで提供する | 承認 |
| [0013](./0013-observability.md) | 可観測性は console/構造化ログと Workers の tail/Logs に接続して提供する | 承認 |
| [0014](./0014-bundle-size-limits-performance.md) | バンドルサイズ・CPU・メモリ制限を一級制約として設計する | 承認 |
| [0015](./0015-build-deploy-ci-pipeline.md) | ビルド・デプロイ・CI パイプラインを ghc-wasm-meta + post-linker + wrangler で構成する | 承認 |
| [0016](./0016-non-fetch-entrypoints.md) | Worker の非 fetch エントリポイント（scheduled / queue / tail）を扱う | 承認 |
| [0017](./0017-testing-strategy.md) | テスト戦略を vanilla GHC 単体・wasm 統合・servant 互換性検証で定義する | 承認 |
| [0018](./0018-versioning-release-distribution.md) | ライブラリのバージョニング・リリース・配布方針を定める | 承認 |
| [0019](./0019-monorepo-package-layout.md) | ライブラリのモノレポ構成と4パッケージ分割を定める | 承認 |
| [0020](./0020-cloudflare-verification-cycle.md) | Cloudflare 上での動作を確証する3重ループ検証サイクルを定める | 承認 |
| [0021](./0021-language-edition-ghc2024.md) | 全パッケージの default-language を GHC2024 に統一する | 承認 |
| [0022](./0022-workers-cache.md) | Workers Cache は値レベル typed builder と servant 型レベル combinator の両方を提供する | 承認 |
| [0023](./0023-js-glue-typescript-policy.md) | JS glue 層は TypeScript 化し、wasmExports 境界型は API-LEDGER manifest から生成する | 承認 |

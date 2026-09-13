# cloudflare-workers-hs

[English](README.md)

`cloudflare-workers-hs` は、GHCの `wasm32-wasi` バックエンドでCloudflare Workersを構築するための、ソース利用を前提としたHaskellライブラリ群です。CloudflareランタイムBinding、Servantサーバーインタープリター、`fetch` ベースのServant Client、Cloudflare Access認証を提供します。

現在はリリース前の試運転段階です。Hackageには公開しておらず、安定性や互換性はまだ保証しません。examplesとCIでは、Haskellのネイティブテストに加えて、workerd、Wrangler、Dockerで実WASMを検証します。

## リポジトリ構成

| パス | 役割 | 状況 |
| --- | --- | --- |
| [`cloudflare-workers/`](cloudflare-workers/) | Request、Response、イベント入口、Streaming、Observability、KV、D1、R2、Queue、Durable Objects、Workflows、Cache、Assets、Service Binding、SocketのBinding | リリース前ライブラリ、`0.1.0.0` |
| [`servant-cloudflare-workers/`](servant-cloudflare-workers/) | Servantサーバーインタープリターと `NamedRoutes` 統合 | リリース前ライブラリ、`0.1.0.0` |
| [`servant-cloudflare-workers-client/`](servant-cloudflare-workers-client/) | Workersの `fetch` を使うServant Client | リリース前ライブラリ、`0.1.0.0` |
| [`servant-cloudflare-workers-access/`](servant-cloudflare-workers-access/) | Web CryptoによるCloudflare Access JWT検証 | リリース前ライブラリ、`0.1.0.0` |
| [`examples/`](examples/) | デプロイ可能なexampleと統合テスト | リポジトリ内の非公開アプリケーション |
| [`conformance-oracle/`](conformance-oracle/) | `servant-server` を使う比較オラクル | リポジトリ専用テストパッケージ |
| `testing-support/` | レイヤー化したテスト検出の共通処理 | リポジトリ専用テストパッケージ |

TypeScript runtimeは別リポジトリの [`cloudflare-workers-hs-runtime`](https://github.com/lihs-ie/cloudflare-workers-hs-runtime) で管理します。このworkspaceはpnpm catalogで正確なGit revisionを参照し、アプリケーションは `@cloudflare-workers-hs/runtime` としてimportします。

```text
applications
  ├─ servant-cloudflare-workers-access
  ├─ servant-cloudflare-workers-client
  └─ servant-cloudflare-workers
       └─ cloudflare-workers
            └─ @cloudflare-workers-hs/runtime
```

## 必要な環境

- ネイティブのビルドとテスト用のGHC `9.14.1` とCabal `3.16.1.0`
- Workerビルド用のGHC WASM `wasm32-wasi` toolchain
- Node.js 24とpnpm `12.4.1`
- lockされたpnpm workspaceから導入するWrangler
- 記載したタスクを実行するための `just`
- `just test-docker` 用のDocker

`nix develop` は `x86_64-linux` と `aarch64-darwin` でWASM toolchain、Node.js、pnpm、リポジトリ用ツールを提供します。ネイティブGHCは含めていないため、GHCupなどでGHC `9.14.1` を別途導入してください。

## はじめかた

```sh
nix develop
just setup-js
just test-minimal
```

[minimal example](examples/minimal/README.md)では、Haskellの入口、`NamedRoutes` API、TypeScript loader、Wrangler設定、生成WASM、および別プロジェクトへ移す際に必要なファイルを説明しています。

## Examples

| Example | 確認できる内容 | コマンド |
| --- | --- | --- |
| [Minimal](examples/minimal/README.md) | Platform Bindingを使わない1つの `GET /health` API | `just test-minimal` |
| [Quickstart](examples/quickstart/README.md) | Access、D1、R2、Queue、Scheduled、Durable Objectsを使う複数Worker構成のURL短縮アプリ | `just test-dev` |
| [Library examples](examples/library-examples/README.md) | KV、Cache、D1、R2、型付きClient、Queue、Socket、設定、ログ | `just test-library-examples` |
| [Static Assets](examples/static-assets/README.md) | 1つのWorkerによる静的ファイルとHaskell APIの配信 | `just test-static-assets` |
| [Realtime](examples/realtime/README.md) | WebSocketとDurable Object SQL | `just test-realtime` |
| [Workflows](examples/workflows/README.md) | 永続step、retry、wait、event、lifecycle control | `just test-workflows` |

ディレクトリ規約は[exampleガイド](examples/README.md)、各機能の実装場所と検証場所は [`examples/features.md`](examples/features.md) を参照してください。

## 開発コマンド

```sh
just build-host             # ネイティブHaskell workspaceをビルド
just build-wasm             # WASM workspaceをビルド
just test-host              # ネイティブの単体・統合テスト
just test-conformance       # Servantの振る舞い比較
just test-integration       # 実WASMとworkerdの統合テスト
just test-model             # 生成した状態機械シナリオ
just test-dev               # wrangler dev経由の本番Worker検証
just test-docker            # Linux Docker/workerd経由の本番Worker検証
just test-registration      # テスト入口とCabal登録の検査
just test-tools             # テスト基盤の回帰テスト
just test-coverage-report   # 計測済み・未計測を明示したcoverageを保存
```

`just test-coverage` は複数ランタイムを合わせた完全なcoverage目標を強制し、必要な証跡がない場合や未達の場合に失敗します。`just test-coverage-report` は同じ保守的なレポートを出力しますが、coverage未達だけでは失敗させません。どちらもテスト失敗を成功には変えません。証跡はGit管理外の `artifacts/testing/` に保存します。

## 試運転での利用

試運転中は、checkoutしたソースツリーまたはCabal projectで固定したGit revisionからHaskellパッケージを利用してください。Hackageのリリースにはまだ依存できません。TypeScript runtimeも [`pnpm-workspace.yaml`](pnpm-workspace.yaml) で固定されています。利用側で `pnpm pack` を実行する必要はありません。

[minimal exampleの切り出し手順](examples/minimal/README.md#独立したプロジェクトにする場合)から始めてください。バージョンと配布方針は [ADR-0018](docs/adr/0018-versioning-release-distribution.md)、runtimeを別リポジトリに分離した判断は [ADR-0025](docs/adr/0025-separate-typescript-runtime-repository.md) に記録しています。

## 提供範囲

このライブラリ群は、実装済みのCloudflare BindingとWorkers Runtime APIへの型付きHaskell interface、Servant Server/Client、Cloudflare Access認証、および別配布のTypeScript runtimeとのWASM接続を提供します。

Cloudflare Bindingは、CloudflareまたはWranglerが設定し、platform resourceまたはcapabilityとしてWorkerの`env`へ供給するものです。Request、Response、fetch、Cache、stream、socket、Web CryptoなどはWorkers Runtime APIであり、Bindingとは区別します。

外部npm packageやSDK、アプリ固有のdomain model・schema・認可・retry、および複数operationの組み合わせは提供範囲外です。例えば`aws4fetch`はCloudflareのR2 docsで紹介されていますがBindingではなく、利用アプリが所有するnpm依存です。R2取得→Images変換→R2保存も利用アプリのworkflowです。詳細な判断は[ADR-0027](docs/adr/0027-define-consumer-library-boundary.md)を参照してください。

## 利用者向けAgent Skill

利用アプリを作成・変更・レビューするエージェント向けに、`use-cloudflare-workers-hs` Skillを同梱しています。GitHub CLIの`gh skill`（preview）で、利用するライブラリと同じtagまたはcommitへ固定して導入してください。

```sh
gh skill preview lihs-ie/cloudflare-workers-hs use-cloudflare-workers-hs

gh skill install lihs-ie/cloudflare-workers-hs use-cloudflare-workers-hs \
  --agent codex \
  --scope project \
  --pin 0123456789abcdef
```

`0123456789abcdef`は、アプリのCabal projectが参照する`cloudflare-workers-hs`と同じtagまたはcommitに置き換えます。Skillの正本は[`skills/use-cloudflare-workers-hs`](skills/use-cloudflare-workers-hs)です。

## アーキテクチャ

[ADR一覧](docs/adr/README.md)では、WASM backend、reactor統合、JSFFI境界、Servant実行、Cloudflare Binding、認証、WebSocket、Workflows、テスト、配布を説明しています。リポジトリ固有の用語は[用語集](GLOSSARY.md)を参照してください。

## ライセンス

リポジトリ全体のライセンスは [MIT](LICENSE) です。各Cabal manifestにはpackage別のライセンスも宣言されています。配布前に対象packageのmanifestを確認してください。

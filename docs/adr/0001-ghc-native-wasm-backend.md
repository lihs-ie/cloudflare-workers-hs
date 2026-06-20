# ADR-0001: コンパイルツールチェーンに GHC ネイティブ WebAssembly バックエンドを採用する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0002](./0002-wasi-reactor-workerd-integration.md), [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [調査メモ](../research/feasibility-servant-on-cloudflare-workers.md)

## 背景と課題 (Context)

`cloudflare-workers-hs` は Haskell の Servant を Cloudflare Workers (workerd) 上で動かすための
ライブラリである。Cloudflare Workers は V8 isolate もしくは WebAssembly モジュールを実行する
ランタイムであり、Haskell を実行するには Haskell コードを **WebAssembly へコンパイルする経路**を
最初に確定させる必要がある。これはライブラリ全体の前提となる基盤決定であり、後続のすべての ADR
（JSFFI、reactor モデル、ビルド基盤）がこの選択に依存する。

Haskell→WASM の歴史的経路は大きく 2 つある。1 つは Tweag が開発した独立コンパイラ **Asterius**、
もう 1 つは **GHC 本体にマージされたネイティブ WebAssembly バックエンド** (`wasm32-wasi`) である。

## 決定要因 (Decision Drivers)

- 上流（GHC 本体）で継続的に保守され、最新の GHC・ライブラリ群に追従できること
- JavaScript との相互運用 (JSFFI) を一級でサポートし、fetch/Request/Response を呼べること
- Cloudflare Workers 上で実際に動作する実績があること
- Template Haskell 等、Haskell エコシステムが前提とする機能が利用できること

## 検討した選択肢 (Considered Options)

1. **GHC ネイティブ WebAssembly バックエンド (`wasm32-wasi`)**
2. **Asterius**（独立した Haskell→WASM コンパイラ）
3. **GHCJS 等 JavaScript へのトランスパイル**（WASM ではなく JS 出力）

## 決定 (Decision)

採用する選択肢: **GHC ネイティブ WebAssembly バックエンド (`wasm32-wasi`)**

GHC wasm バックエンドは「unregisterised/LLVM/NCG」とは別の意味での、`wasm32-wasi` を
ターゲットとするクロスコンパイラである。2022-11-22 に GHC 本体へマージされ、公式かつ保守される
唯一の前向きなツールチェーンとなった。これに伴い Asterius は **非推奨**となり、リポジトリは
2022-11-24 にアーカイブ（読み取り専用）された。したがって Asterius を新規採用する合理性は無い。

GHC ネイティブバックエンドは `foreign import/export javascript`（JSFFI）を一級サポートし、
これが Workers の fetch/Request/Response/Promise を呼ぶための土台になる（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）。
本番稼働実績（gohan.konn-san.com）もこのバックエンド上で得られている。

## 結果 (Consequences)

### 良い結果 (Positive)

- 上流 GHC の改善（最適化・バグ修正・新機能）を継続的に享受できる。
- JSFFI により Workers ランタイム API を型付きで呼べる土台が得られる。
- 既存の本番事例・先行実装（konn エコシステム）と同じ基盤に乗れる。

### 悪い結果・トレードオフ (Negative)

- **stock GHCup では入らない。** 専用の GHC ビルド（`ghc-wasm-meta` 等）が必要で、ビルド環境の
  セットアップコストが上がる（→ [ADR-0015](./0015-build-deploy-ci-pipeline.md)）。
- `wasm32-wasi` でビルドできないパッケージ（`network`, `crypton` 等の C/ソケット依存）が存在し、
  依存グラフの精査が必要（→ [ADR-0006](./0006-servant-execution-engine.md), [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）。
- 現状 RTS は単一スレッド（`-threaded` 不可）。並行モデルに制約がある（→ [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）。

### 中立・フォローアップ (Neutral / Follow-up)

- 採用する最小 GHC バージョンは **9.10 を下限、Template Haskell/ghci を要する場合は 9.12 以上**とする
  （TH/ghci は 9.12 から対応、splice は Node.js の外部インタプリタで評価）。具体的なバージョン固定は
  [ADR-0015](./0015-build-deploy-ci-pipeline.md) で扱う。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### GHC ネイティブ WebAssembly バックエンド

- 利点: 上流保守、JSFFI 一級対応、本番実績、最新 GHC 追従。
- 欠点: 専用 GHC ビルドが必要、一部 C 依存パッケージが不可、単一スレッド RTS。

### Asterius

- 利点: かつて Cloudflare Workers 上での実証例があり、async FFI/Promise も実装していた。
- 欠点: **非推奨・アーカイブ済み (2022-11-24)**。保守されず、最新 GHC に追従しない。新規採用不可。

### GHCJS 等 JS トランスパイル

- 利点: ブラウザ/JS ランタイムとの親和性。
- 欠点: WASM ではなく JS 出力で、Workers の WASM 実行モデルや本ライブラリの WASM 前提と整合しない。
  上流追従・保守性でもネイティブバックエンドに劣る。

## 遵守事項 (Compliance)

- [ ] ビルドは `wasm32-wasi` ターゲットの GHC でのみ行い、Asterius を依存に含めない。
- [ ] CI でツールチェーン（GHC wasm バックエンド）のバージョンを固定・記録する。
- [ ] 依存追加時に `wasm32-wasi` でのビルド可否を確認する手順を設ける。

## 参考資料 (References)

- GHC User's Guide — WebAssembly backend: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Tweag — The Wasm backend is merged into GHC (2022-11-22): https://www.tweag.io/blog/2022-11-22-wasm-backend-merged-in-ghc
- Tweag — Template Haskell and GHCi for Wasm: https://www.tweag.io/blog/2024-11-21-ghc-wasm-th-ghci/
- Asterius（アーカイブ済み）: https://github.com/tweag/asterius

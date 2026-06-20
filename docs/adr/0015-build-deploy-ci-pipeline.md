# ADR-0015: ビルド・デプロイ・CI パイプラインを ghc-wasm-meta + post-linker + wrangler で構成する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0001](./0001-ghc-native-wasm-backend.md), [ADR-0002](./0002-wasi-reactor-workerd-integration.md), [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0014](./0014-bundle-size-limits-performance.md)

## 背景と課題 (Context)

GHC ネイティブ WASM バックエンド（[ADR-0001](./0001-ghc-native-wasm-backend.md)）は stock GHCup に
含まれず、専用ツールチェーンが要る。reactor モジュール（[ADR-0002](./0002-wasi-reactor-workerd-integration.md)）の
リンク、post-linker（`post-link.mjs`）による JSFFI グルー生成（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）、
WASI shim・エントリ JS・`.wasm` のバンドル、`wrangler` での module Worker デプロイまでを、
再現可能な形で CI に載せる必要がある。バンドルサイズ最適化（[ADR-0014](./0014-bundle-size-limits-performance.md)）も
パイプラインに組み込む。

## 決定要因 (Decision Drivers)

- WASM 対応 GHC を再現可能に取得・固定できること
- post-linker・バンドル・デプロイを自動化できること
- 再現性（ロックされた依存・ツールチェーン）と CI でのキャッシュ
- バンドルサイズ計測/最適化をパイプラインに組み込めること

## 検討した選択肢 (Considered Options)

1. **`ghc-wasm-meta`（Nix flake を主、ghcup 型インストーラを副）でツールチェーンを取得し、cabal でビルド → post-linker → `wasm-opt` → バンドル → `wrangler` deploy を CI 化する**
2. Earthly ベースのビルド（先行事例 `ghc-wasm-earthly` のコンテナ）に乗る
3. 各自の環境で手動ビルドし、成果物をアップロードする

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- **ツールチェーン取得**: `ghc-wasm-meta` を用い、**Nix flake を主**（再現性・ロック）とし、Nix を使わない
  環境向けに ghcup 型インストーラ経路を副として文書化する。GHC バージョンは固定（下限 9.10、
  TH/ghci を使う場合 9.12 以上）、`cabal` は TH/動的リンク対応に必要なバージョン（3.14 以上）を要件とする。
- **ビルド**: `wasm32-wasi` ターゲットで `cabal build`。リンクは reactor 設定
  （`-no-hs-main -optl-mexec-model=reactor` + 必要な `--export`）。
- **後処理**: `post-link.mjs` で `ghc_wasm_jsffi` グルーを生成、`wasm-opt`/strip でサイズ最適化
  （[ADR-0014](./0014-bundle-size-limits-performance.md)）。
- **バンドル**: エントリ JS（`export default { fetch }`、[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）、
  生成グルー、WASI shim（[ADR-0002](./0002-wasi-reactor-workerd-integration.md)）、`.wasm` を `wrangler` の
  module Worker としてまとめる（`.wasm` は WebAssembly module として binding）。
- **デプロイ**: `wrangler.toml` で binding（KV/R2/D1/DO/Queues/Service Bindings: [ADR-0008](./0008-cloudflare-platform-bindings.md)）と
  Worker を宣言。サイズ超過時の **複数 Worker 分割**（[ADR-0014](./0014-bundle-size-limits-performance.md)）にも対応した構成例を用意する。
- **CI**: ツールチェーン/依存をロック・キャッシュし、ビルド・テスト・サイズ計測・（必要なら）デプロイを
  実行。バンドルサイズのしきい値をゲートにする。

## 結果 (Consequences)

### 良い結果 (Positive)

- WASM GHC を再現可能に取得でき、ビルド〜デプロイが自動化される。
- post-linker/最適化/バンドルが標準化され、属人性が下がる。
- サイズ計測がパイプラインに入り、デプロイ不能を未然に防げる。

### 悪い結果・トレードオフ (Negative)

- 専用ツールチェーンのセットアップ・キャッシュ調整の初期コスト。
- ツールチェーン更新（GHC/post-linker）追従の保守。
- WASM ビルドは時間・リソースを要し、CI キャッシュ設計が重要。

### 中立・フォローアップ (Neutral / Follow-up)

- ローカル開発体験（`wrangler dev` + WASM 再ビルドのウォッチ）の整備。
- ツールチェーンを固定する具体的な GHC/`cabal`/`ghc-wasm-meta` のバージョンを確定し記録する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `ghc-wasm-meta`（Nix 主）+ post-linker + wrangler

- 利点: 再現性が高く、公式ツールチェーン経路に沿う。CI 化・キャッシュしやすい。
- 欠点: Nix/専用環境の学習・整備コスト。

### Earthly ベース

- 利点: 先行事例があり、コンテナで再現性を得やすい。
- 欠点: Earthly への依存。本ライブラリはツールチェーン取得を `ghc-wasm-meta` に寄せ、設計参照に留める。

### 手動ビルド

- 利点: 前準備が最小。
- 欠点: 再現性・自動化が無く、実運用に不適。

## 遵守事項 (Compliance)

- [ ] ツールチェーン（GHC wasm / `cabal` / `ghc-wasm-meta`）のバージョンをロックし CI で固定する。
- [ ] リンクは reactor 設定で行い、`post-link.mjs` のグルーをバンドルに含める。
- [ ] `wasm-opt`/strip とバンドルサイズ計測（しきい値ゲート）をパイプラインに組み込む。
- [ ] `wrangler.toml` の binding 宣言と Haskell 側の型宣言（[ADR-0008](./0008-cloudflare-platform-bindings.md)）の整合を確認する。

## 参考資料 (References)

- GHC User's Guide — WebAssembly backend（reactor リンク / post-linker）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Tweag — Template Haskell and GHCi for Wasm（cabal-3.14 等の前提）: https://www.tweag.io/blog/2024-11-21-ghc-wasm-th-ghci/
- konn/ghc-wasm-earthly（Earthly ビルドの先行例・設計参照）: https://github.com/konn/ghc-wasm-earthly
- Cloudflare Workers — Limits: https://developers.cloudflare.com/workers/platform/limits/

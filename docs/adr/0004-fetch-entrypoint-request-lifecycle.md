# ADR-0004: fetch ハンドラを foreign export で公開しリクエストごとのライフサイクルを定義する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0002](./0002-wasi-reactor-workerd-integration.md), [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0005](./0005-http-layer-no-wai.md), [ADR-0014](./0014-bundle-size-limits-performance.md)

## 背景と課題 (Context)

module 形式の Cloudflare Worker は `export default { fetch(request, env, ctx) }` を入口とする。
本ライブラリは Haskell（WASM, reactor モジュール: [ADR-0002](./0002-wasi-reactor-workerd-integration.md)）側に
このハンドラを実装し、JS の入口へ接続しなければならない。あわせて、reactor の初期化（`_initialize` /
RTS 初期化）を「isolate 起動時に一度」行い、以後はリクエストごとにハンドラを呼ぶ
**リクエストごとのライフサイクル**を定義する必要がある。

GHC wasm の RTS は現状 **単一スレッド**（`-threaded` 不可）であり、`fetch` の各引数
（`request` / `env` / `ctx`）は JSFFI（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）で型付きに
受け取る。Servant のハンドラは I/O を行うため、export は **非同期（Promise を返す）**になる。

## 決定要因 (Decision Drivers)

- module 形式 Worker の `fetch(request, env, ctx)` 形状に素直に対応すること
- 初期化を isolate あたり一度に限定し、ウォーム状態を活かしてコールドスタートを抑えること
- 単一スレッド RTS と async JSFFI の制約下で正しく動くこと
- `env`/`ctx`（[ADR-0008](./0008-cloudflare-platform-bindings.md)）をハンドラ文脈へ届けられること

## 検討した選択肢 (Considered Options)

1. **`foreign export javascript` で型付き `fetch` ハンドラを公開し、`main` は no-op、初期化は reactor `_initialize` に委ねる**
2. command モデルで `main` を入口にし、stdin/stdout に HTTP を写像する
3. リクエストごとに RTS を初期化し直す

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- Haskell 側で `fetch :: Request -> Env -> Context -> IO Response` 相当の型付きハンドラを実装し、
  `foreign export javascript` で JS へ公開する。JS の薄いエントリ（module Worker の
  `export default { fetch }`）はこの export を呼ぶだけにする。
- プログラムの `main` は **no-op (`main = pure ()`)** とし、実行はすべて export 経由でリクエスト時に駆動する。
  これは reactor モデル（[ADR-0002](./0002-wasi-reactor-workerd-integration.md)）に整合する。
- RTS/`_initialize` は **isolate 起動時に一度だけ**呼ぶ。以後、温存された isolate に対して
  `fetch` export を都度呼び、ウォーム状態（読み込み済みコード・初期化済みヒープ）を活かす。
- ハンドラの戻り値は I/O を含むため **async export（Promise）**として表現する。`request`/`env`/`ctx` は
  バインディング層（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）の型でラップして渡す。
- **同時実行**: 1 つの isolate は複数リクエストを同時に処理しうる。Haskell 側は単一スレッド RTS の
  スケジューラと async JSFFI でこれらをインターリーブする（OS スレッドは増やさない）。
- **`ctx.waitUntil` の契約**: レスポンス後の非同期処理を登録する API を提供する。`waitUntil` 内の通信も
  サブリクエスト数・CPU 予算（[ADR-0014](./0014-bundle-size-limits-performance.md)）を消費することを契約として明示する。
  `ctx.passThroughOnException` も同様にバインドする。

## 結果 (Consequences)

### 良い結果 (Positive)

- `fetch(request, env, ctx)` に 1:1 対応し、JS グルーを最小化できる。
- 初期化が isolate あたり一度で済み、リクエスト間のウォーム状態でレイテンシを抑えられる。
- ハンドラ文脈に `env`/`ctx` を型付きで届けられ、Servant の文脈（[ADR-0008](./0008-cloudflare-platform-bindings.md)）に接続できる。

### 悪い結果・トレードオフ (Negative)

- **isolate が長命なため線形メモリは単調に増えやすい**。GC は単一スレッド RTS のもとで動くため、
  メモリ・CPU の挙動を実測し、必要なら定期的な状態リセット戦略を要する（[ADR-0014](./0014-bundle-size-limits-performance.md)）。
- C-FFI 由来の同期コンテキストから async JSFFI を force すると `WouldBlockException`。境界設計に注意。
- isolate 間で状態は共有されない（各 isolate は独立）。永続状態は外部バインディング（KV/D1/Durable Objects）に置く。
- 同一 isolate 内で複数リクエストが同時進行しうるため、可変なグローバル状態は競合・リークの温床になる。
  リクエスト固有状態はハンドラ内に閉じ込め、共有可変状態を避ける。

### 中立・フォローアップ (Neutral / Follow-up)

- `waitUntil` のタイムアウト/キャンセル挙動の詳細と、登録処理の失敗時のログ方針を詰める。
- リクエスト→ルーティング→レスポンスの内部フローは [ADR-0005](./0005-http-layer-no-wai.md) / [ADR-0006](./0006-servant-execution-engine.md) で扱う。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 型付き `fetch` export + no-op `main` + reactor 初期化

- 利点: Worker 形状に一致、ウォーム活用、初期化が一度。
- 欠点: 単一スレッド/async 境界の制約を意識する必要。

### command モデル（`main` 入口）

- 利点: 概念が単純。
- 欠点: リクエストごとに起動し直す形でウォーム状態を活かせず、JSFFI reactor 要件とも不整合。

### リクエストごとに RTS 初期化

- 利点: 状態リークを避けやすい。
- 欠点: コールドスタート相当のコストが毎回かかり、短い CPU 予算（[ADR-0014](./0014-bundle-size-limits-performance.md)）に反する。

## 遵守事項 (Compliance)

- [ ] `fetch` ハンドラは `foreign export javascript` で公開し、JS エントリはそれを呼ぶだけにする。
- [ ] `main` は no-op とし、初期化ロジックを `main` に置かない。
- [ ] `_initialize`/RTS 初期化は isolate あたり一度のみ実行する。
- [ ] ハンドラの永続状態は isolate ローカル変数に依存させず、外部バインディングに格納する。

## 参考資料 (References)

- GHC User's Guide — WebAssembly backend（reactor / JSFFI export / 単一スレッド RTS）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Haskell Discourse — Serverless Haskell with GHC WASM + JSFFI on Cloudflare Workers: https://discourse.haskell.org/t/serverless-haskell-with-ghc-wasm-jsffi-cloudflare-workers/9784
- Cloudflare Workers — Limits（CPU/メモリ）: https://developers.cloudflare.com/workers/platform/limits/

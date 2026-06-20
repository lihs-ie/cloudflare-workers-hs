# ADR-0002: WASI reactor モデルで workerd にモジュールを組み込む

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0001](./0001-ghc-native-wasm-backend.md), [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md)

## 背景と課題 (Context)

GHC ネイティブ WASM バックエンド（[ADR-0001](./0001-ghc-native-wasm-backend.md)）で生成した
`.wasm` を Cloudflare Workers (workerd) に読み込ませる方式を決める必要がある。WebAssembly/WASI には
2 つの実行モデルがある。

- **command モデル**: `_start` を入口に、プログラムを起動から終了まで一度走らせる（CLI 的）。
  実験的かつ未保守の `@cloudflare/workers-wasi`（後述、最終リリース v0.0.5 / 2022-02-07）は、
  stdin/stdout を HTTP リクエスト/レスポンス本文へ写像する command 形式を提供していた。
  これは Cloudflare ランタイムの現行・公式機能ではなく、当該実験的パッケージの慣習である点に注意。
- **reactor モデル**: `_initialize` で初期化したのち、JS 側から **export された関数を都度呼ぶ**
  （ライブラリ的・常駐型）。

Servant のような「リクエストごとにハンドラを呼ぶ」サーバ用途では、isolate を温存したまま
ハンドラを繰り返し呼べる reactor モデルが自然である。また JSFFI を使う GHC wasm モジュールは
reactor としてのビルドが要求される。

## 決定要因 (Decision Drivers)

- リクエストごとにハンドラを呼べ、isolate のウォーム状態を活かせること
- JSFFI（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）の要件（reactor ビルド）と整合すること
- 組み込みに用いる JS グルーの保守性・将来性（実験的依存への過度な固定を避ける）

## 検討した選択肢 (Considered Options)

1. **reactor モジュール + `@cloudflare/workers-wasi`（ダミー `_start` で `wasi.start()` を呼ぶ）**
2. **reactor モジュール + 最小の自前 `wasi_snapshot_preview1` shim**
3. **command モデル（stdin/stdout を HTTP に写像）**

## 決定 (Decision)

採用する選択肢: **reactor モジュール**。JS グルーは当面 **選択肢 1（`@cloudflare/workers-wasi`）を
出発点**としつつ、**選択肢 2（最小自前 WASI shim）への移行を前提**とする。

JSFFI を使う以上、`wasm32-wasi` の **reactor** モジュールとしてビルドする
（`-no-hs-main -optl-mexec-model=reactor` と `--export`）。reactor ABI の `_initialize` は
リンク時に自動生成され、**他の export を呼ぶ前に一度だけ**呼ぶ必要がある。読み込みは
`WebAssembly.instantiate` に `ghc_wasm_jsffi`（post-linker 生成、[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）と
`wasi_snapshot_preview1` の import を渡す。

先行実装では `@cloudflare/workers-wasi` を使い、同ライブラリに `wasi.initialize()` が無いため
ダミーの `_start()` を与えて `wasi.start()` を呼び、Worker は既定 export として `fetch` を公開して
いる。ただし `@cloudflare/workers-wasi` は **実験的で最終リリース v0.0.5 (2022-02-07)、事実上
未保守**である。本ライブラリは初期はこれを利用しつつ、`wasi_snapshot_preview1` のうち必要な
最小サブセットのみを実装する自前 shim を整備し、外部依存の陳腐化リスクを下げる。

## 結果 (Consequences)

### 良い結果 (Positive)

- isolate を温存したままハンドラを都度呼べ、リクエスト間でウォーム状態（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）を活かせる。
- JSFFI 要件（reactor）と整合する。

### 悪い結果・トレードオフ (Negative)

- `@cloudflare/workers-wasi` は未保守の実験的依存であり、長期固定はリスク。自前 shim 整備の工数が必要。
- WASI 実装が不完全（例: `poll_oneoff` 欠落）で、ブロッキング系の前提が崩れる箇所がある。
- ソケット系 syscall は `ENOSYS`。サーバソケット/送信ソケットは使えない（→ [ADR-0005](./0005-http-layer-no-wai.md), [ADR-0011](./0011-outbound-http-fetch-backend.md)）。

### 中立・フォローアップ (Neutral / Follow-up)

- 自前 WASI shim が実装すべき最小 syscall 群（`fd_write`, `clock_time_get`, `random_get`, `environ_*` 等）の
  確定は別タスクとする。
- reactor の `_initialize` 呼び出しを「isolate 起動時に厳密に 1 回」に保証する仕組みは
  [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md) で扱う。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### reactor + `@cloudflare/workers-wasi`

- 利点: 先行実装の実績があり、最短で動かせる。
- 欠点: 実験的・未保守 (v0.0.5/2022)。本番依存として脆弱。

### reactor + 自前最小 WASI shim

- 利点: 依存が小さく保守性・バンドルサイズで有利。Workers の制約に合わせて最小化できる。
- 欠点: 実装・検証の初期工数。WASI ABI 追従の責任を負う。

### command モデル

- 利点: 概念が単純（1 起動 = 1 リクエスト）。実験的 `@cloudflare/workers-wasi` が採っていた形式
  （公式・現行機能ではない）。
- 欠点: JSFFI を使う GHC wasm の reactor 要件と不整合。リクエストごとに RTS を起動し直す形になり、
  ウォーム状態を活かせずコールドスタートコストが嵩む。

## 遵守事項 (Compliance)

- [ ] リンクは `-no-hs-main -optl-mexec-model=reactor` で行い、reactor モジュールを生成する。
- [ ] `_initialize` は他の export 呼び出しより前に厳密に 1 回だけ呼ぶ。
- [ ] `@cloudflare/workers-wasi` への依存はバージョン固定し、自前 shim への移行課題を Issue 化する。

## 参考資料 (References)

- GHC User's Guide — WebAssembly backend（reactor ABI / `_initialize`）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Haskell Discourse — Serverless Haskell with GHC WASM + JSFFI on Cloudflare Workers: https://discourse.haskell.org/t/serverless-haskell-with-ghc-wasm-jsffi-cloudflare-workers/9784
- Cloudflare — Announcing WASI on Workers: https://blog.cloudflare.com/announcing-wasi-on-workers/
- @cloudflare/workers-wasi (npm): https://www.npmjs.com/package/@cloudflare/workers-wasi

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

## 追補 (2026-07-22): WASI shim の選定変更

- ステータス: 承認（追補）
- 日付: 2026-07-22
- 決定者: lihs

### 決定

JS グルーの WASI 実装として **`@bjorn3/browser_wasi_shim`（`^0.4.2`、`dependencies` 分類）** を採用する。
本文「決定 (Decision)」節が示した「選択肢 1（`@cloudflare/workers-wasi`）を出発点とし選択肢 2（自前最小
shim）へ移行する」という方針を、本追補は次のとおり置き換える。

> 採用: reactor モジュール + `@bjorn3/browser_wasi_shim`

### 理由

- `@cloudflare/workers-wasi` は 2022-02（v0.0.5）以降実質未保守であり、**command モデルの `start()`
  のみ**を提供する。reactor ABI が要求する `initialize()`（本文の `_initialize` 呼び出しに相当する
  WASI 側の初期化エントリ）には対応していない。
- `@bjorn3/browser_wasi_shim` は pure-JS 実装で、reactor の `initialize()` を直接提供する。
  実機（workerd 1.20260721.1 + `@cloudflare/vitest-pool-workers` 0.18.7 + `wrangler dev`）で
  動作検証済み。

### 注意（foot-gun）

`{debug: false}` を明示しないと、WASI syscall の呼び出しが全て stdout に漏れる（実測で確認済みの
既定挙動）。組み込み時は必ず `{debug: false}` を渡すこと。

### 選択肢 2（自前最小 shim）の扱い

本文が前提としていた「選択肢 2（自前最小 WASI shim）への移行」は、依存削減の観点から**引き続き
open のフォローアップ事項**とする。今回の決定は選択肢 1 → 2 への移行ではなく、選択肢 1 の実装を
`@cloudflare/workers-wasi` から `@bjorn3/browser_wasi_shim` に差し替えるものである。

### 遵守事項への影響（本文 override）

本文「遵守事項 (Compliance)」の以下の項目は、本追補により対象を変更する（本文自体は書き換えない）。

- 「`@cloudflare/workers-wasi` への依存はバージョン固定し、自前 shim への移行課題を Issue 化する。」
  → **追補により対象を `@bjorn3/browser_wasi_shim`（`^0.4.2`）に変更**。バージョン固定・自前 shim
  への移行課題の Issue 化は本追補後も有効。

### 参考資料（追補分）

- @bjorn3/browser_wasi_shim (npm): https://www.npmjs.com/package/@bjorn3/browser_wasi_shim
- bjorn3/browser_wasi_shim (GitHub): https://github.com/bjorn3/browser_wasi_shim

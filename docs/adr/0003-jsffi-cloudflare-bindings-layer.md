# ADR-0003: Cloudflare ランタイム API バインディングを JSFFI で自前実装する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0001](./0001-ghc-native-wasm-backend.md), [ADR-0002](./0002-wasi-reactor-workerd-integration.md), [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0008](./0008-cloudflare-platform-bindings.md)

## 背景と課題 (Context)

Servant ハンドラを Workers 上で動かすには、Haskell（WASM）から Workers ランタイムの JavaScript API
（`fetch` / `Request` / `Response` / `Headers` / `URL` / `ReadableStream` / `env` バインディング群）を
呼び出す手段が要る。GHC ネイティブ WASM バックエンド（[ADR-0001](./0001-ghc-native-wasm-backend.md)）は
このために **JSFFI**（`foreign import/export javascript`）を提供する。

本プロジェクトは「**フォークせず全て自前実装**」する方針のため、konn 氏の
`ghc-wasm-earthly`（`Network.Cloudflare.Worker.*` 等）や `web-sys-hs` 等の既存バインディングは
**依存に含めず、設計参照のみ**とし、本ライブラリ自身のバインディング層を実装する。

## 決定要因 (Decision Drivers)

- 型安全性: JS の動的オブジェクトを Haskell 側で型付きに扱えること
- 非同期: Promise を返す Workers API（`request.json()`、`response.arrayBuffer()` 等）を自然に await できること
- 外部依存の最小化（自前実装方針）と、バンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）への配慮
- post-linker が生成する JS グルーとの整合

## 検討した選択肢 (Considered Options)

1. **自前の JSFFI バインディング層を実装する（型付き `JSObject` ラッパ + 個別 API）**
2. konn `ghc-wasm-earthly` / `web-sys-hs` 等の既存バインディングへ依存する
3. JSFFI を直接ハンドラ中に都度書き、共通バインディング層を設けない

## 決定 (Decision)

採用する選択肢: **自前の JSFFI バインディング層を実装する**

`unsafe` import は同期（ブロッキング）、`safe`/`interruptible`/無注釈 import は非同期で Promise を返し
`await` 可能、export は既定で非同期という JSFFI のセマンティクスを前提に、Workers の主要 API を
型付きでラップする。`foreign import javascript` の Haskell ラッパは、JS 値を不透明な
`JSVal`/`JSObject` 型として保持し、`Request`/`Response`/`Headers`/`ReadableStream` 等に対応する
newtype と型付きアクセサ（メソッド・本文読み出し・ヘッダ操作）を提供する。

JS グルーは GHC libdir 同梱の post-linker (`post-link.mjs`) が `.wasm` を解析して生成する
`ghc_wasm_jsffi` モジュールを用いる。これは `WebAssembly.instantiate` の import として
渡される（[ADR-0002](./0002-wasi-reactor-workerd-integration.md)）。本層は host 非依存に保ち、
特定の Worker 実装詳細をハンドラへ漏らさない。

## 結果 (Consequences)

### 良い結果 (Positive)

- Workers API を型付きで扱え、ハンドラ実装の安全性と可読性が上がる。
- 外部バインディング依存が無く、バンドルサイズと保守範囲を自分で制御できる。
- async JSFFI により Promise ベースの Workers API を素直に表現できる。

### 悪い結果・トレードオフ (Negative)

- 必要な API を逐次バインドする初期・継続工数が発生する。
- C-FFI で export した Haskell 関数から async JSFFI thunk を force すると `WouldBlockException` に
  なるため、同期/非同期境界の設計に注意が要る（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）。
- JS グルーは post-linker の出力に依存するため、ツールチェーン更新時に追従が必要。

### 中立・フォローアップ (Neutral / Follow-up)

- WebIDL からのコード生成でバインディングを半自動化する余地がある（将来課題）。
- `env` バインディング（KV/R2/D1 等）の個別ラッパは [ADR-0008](./0008-cloudflare-platform-bindings.md) で扱う。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 自前バインディング層

- 利点: 型安全・依存最小・サイズ制御。方針（自前実装）と整合。
- 欠点: 実装/保守工数。

### 既存バインディングへ依存

- 利点: 初期工数が小さい。
- 欠点: 自前実装方針に反する。R2/Cache API 周りは「使用を推奨しない」と作者が明記しており脆い。
  保守状況・バンドルサイズを自分で制御できない。

### 共通層なしで都度 JSFFI

- 利点: 最小の前準備。
- 欠点: 型安全性が低く重複が多い。境界条件（async/WouldBlock）を各所で誤りやすい。

## 遵守事項 (Compliance)

- [ ] Workers API へのアクセスは本バインディング層を経由し、ハンドラに生の `foreign import` を散在させない。
- [ ] バインディング層は外部の Cloudflare バインディングライブラリへ依存しない。
- [ ] 非同期 API は async JSFFI（Promise）として型に反映し、同期前提で呼ばない。

## 参考資料 (References)

- GHC User's Guide — WebAssembly backend（JSFFI / post-linker）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Tweag — Template Haskell and GHCi for Wasm（JSFFI の async 統合）: https://www.tweag.io/blog/2024-11-21-ghc-wasm-th-ghci/
- konn/ghc-wasm-earthly（設計参照のみ）: https://github.com/konn/ghc-wasm-earthly

## 追補 (2026-07-23): JSFFI 境界の実装規約 (A1-A3 実機確定)

- ステータス: 承認（追補）
- 日付: 2026-07-23
- 決定者: lihs

Phase A（A1-A3、実機検証済み）で確定した JSFFI 境界の実装規約を記録する。本文「決定 (Decision)」節の
方針（`unsafe` import は同期、`safe`/`interruptible`/無注釈 import は非同期で Promise を返し `await`
可能）を、以下のとおり実装規約として具体化する。本文自体は書き換えない。

### 決定 1: ★重要 toolchain 制約 — `try @JSException` は bare `safe` import の Promise reject を捕捉できない

GHC 9.12.4 wasm32-wasi-ghc の実機検証で確認: Haskell 側で `Control.Exception.try @GHC.Wasm.Prim.JSException`
を bare `safe` import 呼び出しに直接かぶせても、Promise の reject を捕捉できない（`rts_promiseReject`
で uncaught のまま伝播し、`try` フレームを素通りして `foreign export javascript` 境界まで到達する）。

throw しうる JS メソッド（KV/D1/R2 等の変更系メソッド）は、**JS 側の try/catch 封筒**で包む: reject
しない async IIFE を書き、成功/失敗をタグ付き結果オブジェクト（`{ ok: true, value }` /
`{ ok: false, message }`）として resolve する。Haskell 側はこのタグを見て、対応する typed Exception
（例: `D1ExecutionError`）を投げ直す。D1 の `d1Run`/`d1Batch`/`d1Exec` はこの封筒方式を採る。R2 の
`r2Get` 等（reject せず 3 値で resolve する API、[ADR-0008](./0008-cloudflare-platform-bindings.md)
追補参照）は封筒不要である。**この制約は A4 以降の全 binding I/O 実装に適用が必須**である。

### 決定 2: safe/unsafe の割当は対象 JS API の Promise 性で機械的に決める

対象の JS API が Promise を返せば `safe`、同期であれば `unsafe` とする（本文が既に定めた原則の運用
規約化）。

`safe` import は返り値の thenable を暗黙に `await` する仕様であるため、**pending な Promise 自体を
値として受け取りたい場合**（`ctx.waitUntil` に渡す Promise 等）は、thenable ではない封筒オブジェクトで
包む。`waitUntil` の実装（deferred 設計、A1）はこの方式を採る: `{ promise, resolveFunction,
rejectFunction }` という非 thenable な envelope を 1 回の同期 `unsafe` import（`Promise` executor
自体は同期的に走るため、構築そのものは async 境界を越えない）で構築し、`ctx.waitUntil` へは pending の
`.promise` を即座に登録する。実体の完了/失敗は Haskell 側で `forkIO` した green thread が
`resolveFunction`/`rejectFunction` を `unsafe` 呼び出しで叩いて確定させる。

### 決定 3: `Internal.FFI.X` は対応する `Binding.X` を import しない、モジュール間ヘルパ共有もしない

`Internal.FFI.KV`/`Internal.FFI.D1`/`Internal.FFI.R2` はいずれも対応する `Binding.KV`/`Binding.D1`/
`Binding.R2` を import しない（`Binding.X` が `Internal.FFI.X` を import する向きの依存が既にあるため、
循環を避ける）。FFI 層は generic なタプル/`JSVal` で返し、`Binding.X` 側が typed な型へ re-wrap する。

`Internal.FFI` モジュール間でのヘルパ共有もしない。例えば `Internal.FFI.D1` は `Internal.FFI.Env` の
`jsObjectKeys`/`jsArrayLength`/`jsArrayIndex`/`jsObjectGet` を再利用せず、各モジュールに局所コピーを
持つ。

### 決定 4: JSString は FFI 境界を越えられない — Bytes bridge + TextEncoder/TextDecoder

`GHC.Wasm.Prim.JSString` は `foreign import javascript` 境界を越えられない（wasm32-wasi-ghc
9.12.4.20260402 実測: `HsJSString`/`rts_mkJSString`/`rts_getJSString` が未定義でコンパイル不能。
`Data.Coerce.coerce :: JSString -> JSVal` も隠された構築子のためコンパイル不能で、`unsafeCoerce` は
`.hlint.yaml` で禁止済み）。

文字列は `Cloudflare.Workers.Internal.FFI.Text`（`jsValToText`/`textToJSVal`）が担う。実装は
`Internal.FFI.Bytes` の pinned `ByteString` <-> `Uint8Array` bridge を経由する: Haskell 側は
`Data.Text.Encoding` で UTF-8 encode/decode、JS 側は workerd グローバルの `TextEncoder`/
`TextDecoder` を使う。`JSString` を直接 FFI 型として使わない。

### 決定 5: ArrayBuffer を返す API は Uint8Array view 化 + 二段 null 判定、厳密さは API 毎

`ArrayBuffer` を返す API（KV `get`/`getWithMetadata` 等）は `new Uint8Array($1)` で zero-copy view に
してから `Internal.FFI.Bytes.jsByteArrayToByteString` の byte bridge へ渡す。

null 判定は「`safe` method 呼び出し → `unsafe` null probe → （非 null のときのみ）`unsafe` wrap」の
二段で行う。null 判定の厳密さは API ごとに異なる。

- D1 の行デコード（`readRow`）は列値を `null` として厳密（`=== null`）に先行分類してから
  `typeof`/`instanceof` で分岐する（SQLite の `NULL` は JS 側で必ず `null` になる。`undefined` には
  ならない）。
- KV/R2 は nullish（`null`/`undefined` いずれも許容）チェックで判定する（例: R2 の
  `decodeR2ObjectMeta` は `.httpMetadata`/`.customMetadata` を nullish-check してから子フィールドへ
  降りる）。

### 決定 6: probe 用 foreign export は examples 限定、直接呼びは macrotask yield が要る

`_probe*` foreign export（`_probeKvRoundtrip`/`_probeD1Roundtrip`/`_probeR2Roundtrip` 等）は
`examples/quickstart` 内でのみ宣言し、学習者向け本番 `Main.hs` へ複製しない。既存 A2 規約
（`foreign import/export javascript` の許容 site は `Internal/FFI/*` と `examples/quickstart` に限る、
[ADR-0019](./0019-monorepo-package-layout.md) 追補）の再確認である。理由: `foreign export` はリンカの
dead-code-elimination の対象にならず、production `fetch` エントリが呼ばなくても wasm バンドルに残り
続けるため、probe を本番コードに複製すると内部テスト専用の到達経路を出荷物へ露出させてしまう。

probe を直接呼ぶ（実 `fetch()` を経由しない）テストハーネスは workerd の output-gate をバイパスする
ため、KV/D1/R2 の変更系操作（`put`/`delete`/`run`/`batch`/`exec` 等）の後に明示的な macrotask yield
（`setTimeout(..., 0)`。microtask yield やノーイールドでは不安定）を挟まないと、直後の読み取りが
書き込みを確実に観測しない。これは**テストハーネス側の注意点であり、ライブラリ実装自体の問題では
ない**（実 `fetch()` 経由の 1 リクエスト内での読み取りはこの workaround を要しない）。

### 遵守事項への影響（本文 override）

本文「遵守事項 (Compliance)」の以下の項目は、本追補により内容を補強する（本文自体は書き換えない）。

- 「非同期 API は async JSFFI（Promise）として型に反映し、同期前提で呼ばない。」
  → **追補により補強**: 「Promise を返す = `safe`、同期 = `unsafe`」を機械的な割当規則として明文化し
  （決定 2）、throw しうる JS メソッドは JS 側 try/catch 封筒で包む（決定 1）。`try @JSException` を
  bare `safe` import に直接かぶせる実装は禁止とする。
- 「Workers API へのアクセスは本バインディング層を経由し、ハンドラに生の `foreign import` を散在
  させない。」
  → **追補により明確化**: `foreign import/export javascript` の許容 site は `Internal/FFI/*` と
  `examples/quickstart`（[ADR-0019](./0019-monorepo-package-layout.md) 追補）に限る。`_probe*` 系
  export は `examples/quickstart` 限定とし、学習者向け production `Main.hs` へ複製しない（決定 6）。

### 参考資料（追補分）

- [ADR-0008](./0008-cloudflare-platform-bindings.md) 追補（KV/D1/R2 実装で確定した設計 — D1 エラー
  分類・R2 の 3 値 get 等）
- [ADR-0019](./0019-monorepo-package-layout.md) 追補（`Internal/FFI/*` 隔離の適用範囲・
  `examples/quickstart` の位置付け）
- GHC User's Guide — WebAssembly backend（JSFFI `safe`/`unsafe`/`interruptible` セマンティクス）:
  https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- MDN — TextEncoder: https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder
- MDN — TextDecoder: https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder

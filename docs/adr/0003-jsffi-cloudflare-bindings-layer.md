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

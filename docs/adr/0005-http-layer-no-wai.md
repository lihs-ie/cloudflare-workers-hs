# ADR-0005: HTTP 層は WAI を介さず Cloudflare Request/Response を直接扱う

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0007](./0007-streaming-readablestream.md), [ADR-0014](./0014-bundle-size-limits-performance.md)

## 背景と課題 (Context)

通常の Haskell Web スタックは **WAI (Web Application Interface)** を共通インターフェースとし、
`servant-server` は WAI の `Application` を生成、Warp 等の WAI ハンドラがソケットで配信する。
Cloudflare Workers にはソケットサーバが無く、入口は `fetch(request, env, ctx)` で、本文は
`ReadableStream` として授受される。

このとき HTTP 層の設計は 2 方向あり得る。1 つは Workers の `Request`/`Response` を WAI の
`Request`/`Response` に変換して既存の WAI/`servant-server` 資産を再利用する案、もう 1 つは
**WAI を介さず Workers の `Request`/`Response` を直接扱う**案である。

なお前提として、`servant-server`/Warp は推移的に `network` へ依存し `wasm32-wasi` でビルドできない
（[ADR-0006](./0006-servant-execution-engine.md)）。また WASI のソケット syscall は `ENOSYS` で、
そもそもソケット配信は不可能である。

## 決定要因 (Decision Drivers)

- 短い CPU 予算（無料枠で 1 リクエストあたり概ね 10ms 級）内に完了できること
- 本文 `ReadableStream` を余分な変換・バッファリングなしに扱えること（[ADR-0007](./0007-streaming-readablestream.md)）
- `wasm32-wasi` でビルド可能な依存のみで構成できること
- ヘッダ/メソッド/クエリ/ステータス等の素直な対応付け

## 検討した選択肢 (Considered Options)

1. **WAI を介さず Workers `Request`/`Response` を直接扱う独自 HTTP 型を定義する**
2. Workers `Request`/`Response` ↔ WAI `Request`/`Response` を相互変換し WAI 資産を再利用する
3. `network` を `wasm32-wasi` 向けにパッチ/ベンダリングして WAI/Warp を載せる

## 決定 (Decision)

採用する選択肢: **選択肢 1（WAI 非経由・直接扱い）**

バインディング層（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）が提供する Workers の
`Request`/`Response` を、本ライブラリ独自の軽量 HTTP 表現（メソッド・パス・クエリ・ヘッダ・本文・
ステータス）として扱い、Servant の解釈系（[ADR-0006](./0006-servant-execution-engine.md)）へ直接供給する。
本文は可能な限り `ReadableStream` を**素通し**し、WAI のストリーミング表現への変換を挟まない。

先行実装（`servant-cloudflare-workers`）も同様に WAI を介さず直接 `Request`/`Response` を扱う設計を
採っており、その理由は「10ms 級の予算内に完了する必要があり、Workers が `ReadableStream` で内容を
返す以上、WAI への変換が実行時間を浪費するから」である。ヘッダや Cloudflare 固有オプションの操作は
軽く、重い処理は Cloudflare の各種サービスへ委譲できる、という設計思想に従う。

## 結果 (Consequences)

### 良い結果 (Positive)

- `ReadableStream` を素通しでき、変換コスト・レイテンシ・メモリを節約できる（[ADR-0007](./0007-streaming-readablestream.md)）。
- `network`/WAI/Warp という `wasm32-wasi` で不可能な依存を持ち込まずに済む。
- HTTP 型が薄く、バンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）に有利。

### 悪い結果・トレードオフ (Negative)

- **WAI ミドルウェア資産（CORS/gzip/ロギング等）をそのまま使えない**。代替手段が必要（[ADR-0012](./0012-middleware-equivalents.md)）。
- 既存の WAI 前提コード（`servant-server` 含む）と互換でなく、サーバ解釈系を自前実装する必要がある（[ADR-0006](./0006-servant-execution-engine.md)）。

### 中立・フォローアップ (Neutral / Follow-up)

- 独自 HTTP 型の具体的な API（ヘッダ表現、本文の遅延/ストリーム表現）の確定は実装時に詰める。
- エラー応答（Servant の `ServerError` 相当）から Workers `Response` への対応は [ADR-0006](./0006-servant-execution-engine.md) で扱う。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### WAI 非経由・直接扱い

- 利点: 高速・薄い・依存最小・ストリーム素通し。
- 欠点: WAI ミドルウェア非互換、サーバ側を自前実装。

### WAI 相互変換で資産再利用

- 利点: 既存 WAI ミドルウェア/`servant-server` を理屈上は再利用可能。
- 欠点: そもそも `servant-server`/Warp が `network` 依存でビルド不可。`ReadableStream`↔WAI 変換が
  CPU 予算を浪費。実益が乏しい。

### `network` をパッチして WAI/Warp を載せる

- 利点: 既存スタックに最も近い。
- 欠点: ソケットは `ENOSYS` で配信不能。パッチ保守コストが高く、得られるものが無い。実質不可能。

## 遵守事項 (Compliance)

- [ ] HTTP 層は `wai`/`warp`/`network` へ依存しない。
- [ ] 本文は既定で `ReadableStream` を素通しし、不要な全量バッファリングを行わない。
- [ ] Servant 解釈系へは独自 HTTP 型経由で供給し、WAI 型を露出しない。

## 参考資料 (References)

- Haskell Discourse — Blog system on Cloudflare Workers（WAI 非採用の理由・ReadableStream）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- Cloudflare Workers — Streams: https://developers.cloudflare.com/workers/runtime-apis/streams/
- @cloudflare/workers-wasi（ソケット syscall は ENOSYS）: https://www.npmjs.com/package/@cloudflare/workers-wasi

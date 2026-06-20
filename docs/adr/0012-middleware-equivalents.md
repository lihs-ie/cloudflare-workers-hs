# ADR-0012: ミドルウェア相当機能は Servant レベルの変換と Cloudflare エッジで提供する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0005](./0005-http-layer-no-wai.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0013](./0013-observability.md)

## 背景と課題 (Context)

WAI スタックでは CORS・圧縮 (gzip)・ロギング・リクエスト ID 付与などを **WAI ミドルウェア**
（`Application -> Application`）で差し込む。本ライブラリは WAI を介さない（[ADR-0005](./0005-http-layer-no-wai.md)）ため、
既存の WAI ミドルウェア資産は使えない。一方、これらの横断的関心事は実運用で必須である。
Cloudflare はエッジで圧縮・キャッシュ・一部セキュリティ機能を提供しており、Worker 内で全てを
実装する必要はない。

## 決定要因 (Decision Drivers)

- WAI 非依存のまま横断的関心事（CORS/ロギング/リクエスト ID 等）を提供できること
- Cloudflare エッジに任せられるもの（圧縮・キャッシュ）は委譲し、Worker の CPU 予算を節約すること
- Servant の宣言的記述・解釈系（[ADR-0006](./0006-servant-execution-engine.md)）と自然に統合できること

## 検討した選択肢 (Considered Options)

1. **横断的関心事を「リクエスト/レスポンス変換」と Servant 組み合わせ子で提供し、圧縮等はエッジへ委譲する**
2. WAI 互換のミドルウェア型を独自に再現し、`Application -> Application` 風の合成を提供する
3. 各ハンドラ内で都度手書きする（共通機構を設けない）

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- 横断処理は、本ライブラリの HTTP 型（[ADR-0005](./0005-http-layer-no-wai.md)）に対する
  **リクエスト前処理 / レスポンス後処理の合成可能な変換**として提供する。CORS・セキュリティヘッダ付与・
  リクエスト ID 付与などはこの形で実装し、解釈系（[ADR-0006](./0006-servant-execution-engine.md)）の
  入口/出口で適用する。CORS は Servant 組み合わせ子としても露出する。
- **ロギング/トレーシングは [ADR-0013](./0013-observability.md) の可観測性機構**へ接続する（変換の一種として実装）。
- **圧縮 (gzip/brotli) は Cloudflare エッジへ委譲**し、Worker 内で実装しない（CPU 予算節約）。必要時は
  `Content-Encoding` 等のヘッダ制御のみ行う。キャッシュも Cache API/エッジへ委譲する。
- **レート制限・WAF はエッジへ委譲**する（Cloudflare Rate Limiting Rules / WAF / Turnstile）。ライブラリは
  エッジ付与の信号の尊重と、必要時の **429** 表出に責任を持つ。ルート単位のレート制限組み合わせ子は任意提供とする。

## 結果 (Consequences)

### 良い結果 (Positive)

- WAI に依存せず横断的関心事を合成可能な形で提供できる。
- 圧縮/キャッシュをエッジへ委譲し、Worker の CPU・コードサイズを節約できる。

### 悪い結果・トレードオフ (Negative)

- 既存 WAI ミドルウェア（`wai-cors`, `wai-extra` 等）をそのまま使えず、必要分を自前で用意する。
- 変換の合成順序（認証→ロギング→CORS 等）を自分で規定・文書化する必要がある。

### 中立・フォローアップ (Neutral / Follow-up)

- 提供する標準変換のセット（CORS、セキュリティヘッダ、リクエスト ID、ロギング）と既定の適用順を定める。
- ルート単位レート制限組み合わせ子を提供するかの優先度を決める。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 変換 + 組み合わせ子 + エッジ委譲

- 利点: WAI 非依存、合成可能、エッジ活用で軽量。
- 欠点: 標準ミドルウェアの自前再実装が要る。

### WAI 風ミドルウェア型を独自再現

- 利点: 既存の概念モデルに近い。
- 欠点: 重い抽象を持ち込み、直接 `Request`/`Response` 方針（[ADR-0005](./0005-http-layer-no-wai.md)）と二重化する。

### ハンドラ内で都度手書き

- 利点: 前準備が最小。
- 欠点: 重複・適用漏れ・順序の不整合が起きやすい。

## 遵守事項 (Compliance)

- [ ] 横断処理は合成可能な変換/組み合わせ子として提供し、WAI ミドルウェアへ依存しない。
- [ ] 圧縮/キャッシュは原則エッジへ委譲し、Worker 内で重複実装しない。
- [ ] 変換の適用順序を文書化する。

## 参考資料 (References)

- Haskell Discourse — Blog system on Cloudflare Workers（重い処理は Cloudflare サービスへ委譲）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- Cloudflare Workers — Streams / runtime APIs: https://developers.cloudflare.com/workers/runtime-apis/streams/
- Cloudflare Workers — Limits: https://developers.cloudflare.com/workers/platform/limits/

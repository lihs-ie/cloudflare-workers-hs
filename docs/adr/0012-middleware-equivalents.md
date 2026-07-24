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

## 追補 (2026-07-24): Phase A theme A6 で plan 確定した Tier1/Tier2 ミドルウェア構成・適用順序

- ステータス: 承認（追補・plan 確定分）
- 日付: 2026-07-23
- 決定者: lihs

**本追補は plan 確定時点の起票である。実装（batch A6-3 = U9）完了時（U13 close）に整合確認を行い、
乖離があれば本追補への追記または `_phase_b/divergence-notes.md` で記録する。** E-Q11 の粒度厳格化
（裁定確定時点での即時起票、theme close 一括を待たない）の初適用であり、batch A6-0（Step 0 実験）と
並行して本追補を起票している。

Phase A theme A6（エラー設計 + 観測性、研究 3 体が強収束したため synthesizer を省略した orchestrator
裁定、A5 と同基準）で、本文「結果」節が中立・フォローアップとして残していた「提供する標準変換のセット
と既定の適用順を定める」を確定する。本文自体は書き換えない。

### 決定 1: 標準変換の型 — `Middleware env = FetchHandler env -> FetchHandler env`（direct-style）

```haskell
type Middleware env = FetchHandler env -> FetchHandler env
```

WAI 由来の CPS スタイル（`Application -> Application` が内部で continuation を取る形）は採用しない。
本ライブラリは WAI を介さない（[ADR-0005](./0005-http-layer-no-wai.md)）ため、`FetchHandler env` を
そのまま受けてそのまま返す direct-style の関数合成で足りるという判断である。標準セットは
**withRequestId / withStructuredLogging** の 2 つに確定した。配置は **`cloudflare-workers` パッケージ**
（servant 非依存、以下 Tier1）— servant を経由しないアプリでも使える横断関心事という位置づけを保つ。

### 決定 2: 適用順序表（遵守事項「変換の適用順序を文書化」の充足）

| 層 | 役割 | 例外発生時の挙動 |
| --- | --- | --- |
| 1. `withRequestId`（Tier1） | request id 付与（cf-ray 継承 + `crypto.randomUUID` fallback、[ADR-0013](./0013-observability.md) 追補参照） | 例外を発生させない前処理。素通し。 |
| 2. `withStructuredLogging`（Tier1） | try-log-rethrow — ハンドラ実行を `try` で包み、失敗時は構造化ログ（error レベル、sampleRate に関係なく常時 emit）を出してから同じ例外を rethrow する | catch → 構造化ログ出力 → **rethrow（握り潰さない）** |
| 3. handler（Tier2 opt-in、`mapExceptionsToServerError`） | typed 例外を servant `Handler` monad レベルで `ServerError` へ変換。ルート単位の opt-in | 対象 exception のみ `ServerError` へ変換、対象外は素通し |
| 4. `mkFetchHandler` 既存 `try @SomeException` | **無変更の最終防波堤**（凍結 surface） | 到達した全例外を捕捉し 500 応答へ整形（ルート単位 override があれば反映） |

適用順序は 1→2→3→4 の外側から内側（`withRequestId` が最外層＝先に実行・後に完了、`mkFetchHandler` の
`try` が最内層＝既存実装のまま）。この表は a6-plan.md §裁定 の記述を転記・表形式化したものである。

### 決定 3: typed 例外→`ServerError` 変換は `servant-cloudflare-workers` 側（Tier2）

`mapExceptionsToServerError` は **`Servant.Cloudflare.Workers.ErrorMapping`**（Handler monad 上、既存
`ExceptT` 経路を再利用）に置く。Tier1（`cloudflare-workers`、servant 非依存）には置かない。境界の決定
根拠は **パッケージ依存方向**: `ServerError` は `servant-server` 由来の型であり、servant 非依存の Tier1
パッケージがこれを参照すると依存が逆転する。既定 status は「binding I/O 失敗 = 500 維持」
（裁定 1）とし、ルート単位の opt-in override で個別ステータス（502 等）を選べるようにする —
502 差別化を既定にはしない。

typed 例外の taxonomy（`ServerError`/`BindingMissingError`/`D1ExecutionError`/`DOError`/`AccessError`/
`FetchTransportError`/`QueueError`/`ServiceBindingError`/`KVError`/`R2Error`）の全体像は
[ADR-0013](./0013-observability.md) 追補「決定 9」参照。

### 決定 4: CORS/セキュリティヘッダは本 theme 非スコープ、rate limit/WAF エッジ委譲は変更なし

本文が想定していた CORS 組み合わせ子・セキュリティヘッダ付与は A6 のスコープに含まれない。本文の
combinator 方式（将来提供）のまま据え置く。レート制限・WAF のエッジ委譲（本文「決定」節）も無変更。

### 決定 5: `mkFetchHandler` への標準 wiring 内蔵は見送り（裁定 6）

Tier1 標準セット（withRequestId / withStructuredLogging）を `mkFetchHandler` 自体に内蔵することは
見送り、**app 側での明示合成**（例: `withRequestId . withStructuredLogging $ handler`）を採用する。
根拠は凍結 surface 不変原則 — `mkFetchHandler`/`tailLog`/`waitUntilOn`/`Handler` の signature・実装は
Phase A を通じて凍結対象であり、これに新規の暗黙 wiring を追加しない。

### 実装状況（plan 確定時点の記録）

batch A6-0（Step 0 実験、U1/U2）が本追補と並行 dispatch 済み。上記構成の実装 Unit は batch A6-3（U9、
Tier1/Tier2 新設 + `randomUUID` FFI + 適用順序 docs、統合 Unit）であり、本追補起票時点では未着手。
`Cloudflare.Workers.Middleware` / `Servant.Cloudflare.Workers.ErrorMapping` モジュールの実在・型検査
通過は本追補では確認していない。U13（batch A6-6 close）で整合確認する。

### 遵守事項への影響（plan 確定時点の解釈）

- 「変換の適用順序を文書化する。」→ **決定 2 の表で充足見込み**。実装後に実コードの適用順序が表と
  一致するかは U13 で確認する（本追補時点では設計のみ）。

### 参考資料（追補分）

- [ADR-0013](./0013-observability.md) 追補（LogRecord/LoggerConfig の型、request id 生成、error
  taxonomy 決定 9、verify-console-boundary.sh lint gate）
- [ADR-0006](./0006-servant-execution-engine.md)（Handler monad・`ExceptT` 経路）
- 実装詳細・裁定全文: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a6-plan.md`

### 実装確認 (2026-07-24, batch A6-6 U13)

batch A6-3（U9）実装完了・全ゲート 2 連走 EXIT0（`~/.pschool/spikes/cloudflare-workers-hs-build/API-LEDGER.md`
の A6 close item 15 参照）を受けて、本追補の決定 1-5 を実コードと突合した。

- **決定 1**（`Middleware env` 型）: 一致。`skeleton/cloudflare-workers/src/Cloudflare/Workers/Middleware.hs`
  の `type Middleware env = FetchHandler env -> FetchHandler env` は本追補のコードブロックと一致。標準
  セット `withRequestId`/`withStructuredLogging` の配置（Tier1、`cloudflare-workers` パッケージ、servant
  非依存）も一致。
- **決定 2**（適用順序表）: 一致。`Middleware.hs` 自身のモジュール Haddock が「★applied order」として同一
  の 1→2→3→4 順序（`withRequestId` → `withStructuredLogging` → handler → `mkFetchHandler` 既存 `try`）
  を明記しており、実装（`withRequestId`/`withStructuredLogging` の合成方向）もこの順序どおり。
- **決定 3**（`mapExceptionsToServerError` の配置）: 一致。
  `skeleton/servant-cloudflare-workers/src/Servant/Cloudflare/Workers/ErrorMapping.hs` に実装され、
  `Handler` monad の既存 `ReaderT`/`ExceptT` 経路（`mapReaderT`/`mapExceptT`）を再利用。既定 status 500
  維持・route 単位 opt-in override はモジュール自身の Haddock 使用例（`KVGetFailed -> err404` override
  例）で確認。
- **決定 4**（CORS/security headers 非スコープ・rate limit/WAF 委譲不変）: 一致。A6 で CORS/security
  header 関連のコード変更は無し。
- **決定 5**（`mkFetchHandler` 標準 wiring 内蔵見送り）: 一致。`Cloudflare.Workers.Entrypoint.Fetch.mkFetchHandler`
  は無変更（凍結 surface）、`Middleware` は app 側の明示合成としてのみ提供される。

**差分: なし。** 本追補の決定 1-5 は実装後の実コードと完全に一致する。

# ADR-0013: 可観測性は console/構造化ログと Workers の tail/Logs に接続して提供する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0012](./0012-middleware-equivalents.md), [ADR-0014](./0014-bundle-size-limits-performance.md)

## 背景と課題 (Context)

実運用にはログ・メトリクス・エラー報告が要る。Workers にはファイルシステムや常駐エージェントが無く、
観測は基本的に **`console.*` 出力**と、それを収集する **tail workers / Workers Logs** を通じて行う。
Haskell（WASM）からは JSFFI（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）で `console` を呼べる。
ただし出力やシリアライズは CPU 予算（[ADR-0014](./0014-bundle-size-limits-performance.md)）を消費するため、
過剰なログは避ける必要がある。

## 決定要因 (Decision Drivers)

- Workers の観測経路（`console.*` → tail/Logs）に乗ること
- 構造化ログ（JSON）で機械可読にできること
- ハンドラ例外を捕捉してエラー応答とログに反映できること
- CPU 予算を圧迫しないログ量・レベル制御

## 検討した選択肢 (Considered Options)

1. **`console.*`（JSFFI）に出す構造化ログ API を提供し、tail/Logs と外部エラー報告に接続する**
2. ログを蓄積して別経路（KV/外部 HTTP）へ自前送信する独自パイプラインを作る
3. 標準の Haskell ロギングライブラリをそのまま使う

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- JSFFI で `console.log`/`console.error`/`console.warn` を呼ぶ薄いロガーを用意し、その上に
  **構造化ログ（JSON 行）** と **ログレベル**を持つ API を提供する。レベルは設定（Vars/Secrets:
  [ADR-0008](./0008-cloudflare-platform-bindings.md)）で制御する。
- ハンドラ例外は解釈系（[ADR-0006](./0006-servant-execution-engine.md)）の出口で捕捉し、適切な
  ステータス（500 等）へ整形しつつ、エラー内容を構造化ログに出す。リクエスト ID
  （[ADR-0012](./0012-middleware-equivalents.md)）をログに含め、相関を取れるようにする。
- 収集は Cloudflare の **tail workers / Workers Logs** に委ね、必要に応じて外部のエラー報告
  （Sentry 等の HTTP API、[ADR-0011](./0011-outbound-http-fetch-backend.md) の fetch / `ctx.waitUntil`）へ送る。
- ログ出力は CPU 予算を意識し、ホットパスでの過剰な文字列化を避ける（レベルでガード）。

## 結果 (Consequences)

### 良い結果 (Positive)

- 追加インフラ無しに Workers 標準の観測経路へ乗れる。
- 構造化ログで検索・相関が容易になる。
- 例外が握り潰されず、エラー応答とログに反映される。

### 悪い結果・トレードオフ (Negative)

- `console` 出力・JSON 化は CPU を消費するため、ログ過多は予算を圧迫する。
- 分散トレーシングは Workers の機能に依存し、Haskell 側で完結しない。

### 中立・フォローアップ (Neutral / Follow-up)

- メトリクス（カウンタ/レイテンシ）の出力方法（ログ集計か外部送信か）を決める。
- 外部エラー報告先（Sentry 等）の標準サポートを用意するか検討する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `console` 構造化ログ + tail/Logs 接続

- 利点: 標準経路・低コスト・例外捕捉統合。
- 欠点: CPU 消費に注意、トレーシングはランタイム依存。

### 独自送信パイプライン

- 利点: 収集先を自由に選べる。
- 欠点: 実装・運用コストが高く、`ctx.waitUntil` 内でも CPU/サブリクエスト予算を消費。

### 標準 Haskell ロギングライブラリ

- 利点: 使い慣れた API。
- 欠点: ファイル/ハンドル前提のものは Workers に不適合。`console` 出力へ橋渡しが必要で利点が薄い。

## 遵守事項 (Compliance)

- [ ] ログは `console.*`（JSFFI）経由で出し、ファイルシステムや常駐前提の機構に依存しない。
- [ ] ハンドラ例外を捕捉してエラー応答に整形し、構造化ログへ記録する。
- [ ] ログ出力は `Logger` 層経由のみとし、ハンドラ内の直接 `console.*` JSFFI 呼び出しを禁止する（grep/lint で検査）。ホットパスでは出力前にレベルガードを置く。

## 参考資料 (References)

- Cloudflare — Announcing WASI on Workers（標準 Web/console API）: https://blog.cloudflare.com/announcing-wasi-on-workers/
- GHC User's Guide — WebAssembly backend（JSFFI）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Cloudflare Workers — Limits（CPU 予算）: https://developers.cloudflare.com/workers/platform/limits/

## 追補 (2026-07-24): Phase A theme A6 で plan 確定した構造化ロガー・request id・error taxonomy

- ステータス: 承認（追補・plan 確定分）
- 日付: 2026-07-23
- 決定者: lihs

**本追補は plan 確定時点の起票である。実装（batch A6-2 = U8 Logger、batch A6-1 = U6 封筒化、batch
A6-4 = U10 lint gate）完了時（U13 close）に整合確認を行い、乖離があれば本追補への追記または
`_phase_b/divergence-notes.md` で記録する。** E-Q11 の粒度厳格化（裁定確定時点での即時起票、theme
close 一括を待たない）の初適用であり、batch A6-0（Step 0 実験）と並行して本追補を起票している。

Phase A theme A6（エラー設計 + 観測性、研究 3 体強収束のため synthesizer を省略した orchestrator 裁定、
A5 と同基準。研究の中核発見 = un-enveloped async reject の抜け穴 — safe import は thunk を返却し
reject は force 時に初めて発火する（GHC documented semantics）ため、封筒化されていない非同期呼び出し
の reject は `try` を貫通しうる。A1 以来の `rts_promiseReject` 実測の根本原因説明）で、本文が
「中立・フォローアップ」として残していたメトリクス出力方法と、当初「決定」節が抽象的にしか述べて
いなかった構造化ログの具体形・request id の生成方式・エラー taxonomy 全体像を確定する。本文自体は
書き換えない。

### 決定 1: 構造化ログ = 単一 JSON object を `console.log` に渡す（文字列連結禁止）

```haskell
data LogLevel = Debug | Info | Warn | Error
  deriving (Show, Eq, Ord) -- Debug < Info < Warn < Error

data LogRecord = LogRecord
  { logRecordLevel      :: LogLevel
  , logRecordRequestId  :: Text
  , logRecordRayId      :: Maybe Text
  , logRecordMethod     :: Text
  , logRecordPath       :: Text
  , logRecordStatus     :: Maybe Int
  , logRecordDurationMs :: Maybe Double
  , logRecordErrorKind  :: Maybe Text
  , logRecordMessage    :: Text
  }

data LoggerConfig = LoggerConfig
  { loggerConfigMinLevel   :: LogLevel -- 既定 Info
  , loggerConfigSampleRate :: Double   -- 既定 1.0
  }
```

`emitLog` は `LogRecord` を単一の JSON object へまとめてから `console.log` に渡す。複数引数や文字列
連結で組み立てる方式は禁止する — **Workers Logs の自動インデックス機能が単一 JSON オブジェクト引数を
前提とする**ため、文字列連結にすると構造化フィールドがインデックスされない。

### 決定 2: `tailLog` は下位 primitive として signature 不変のまま存置

既存の `tailLog`（薄い `console.log`/`error`/`warn` 呼び出し）は API として残す。構造化ロガー
（決定 1）は `tailLog` を**置き換えるものではなく上位に追加される API**である。`tailLog` は
`waitUntilOn`/`mkFetchHandler`/`Handler` と並ぶ凍結 surface の一部であり、signature・実装とも
Phase A を通じて変更しない。

### 決定 3: request id = cf-ray 継承 + `crypto.randomUUID` fallback

`cf-ray` ヘッダが存在すればそれを request id として継承し、なければ `crypto.randomUUID` で生成する。
**cf-ray の非一意性は caveat として文書化する**（Cloudflare のエッジ層で生成される識別子であり、
本ライブラリが request 相関の一意性を保証する主体ではない）。

**Handler からの request id 直読はスコープ外**（裁定 2）。ログ相関は Tier1 の
`withStructuredLogging`（[ADR-0012](./0012-middleware-equivalents.md) 追補「決定 2」の exit-logging）
一元で足りるという判断であり、Handler 内で request id を直接参照する API は追加しない。

### 決定 4: duration = platform 公表 Wall/CPU time が一次ソース、`Date.now` 差分は相関用 best-effort

Cloudflare が 2025-04 以降 invocation ごとに公表する Wall/CPU time を一次ソースとする。自前
`Date.now` 差分（`logRecordDurationMs`）は相関用の best-effort に留める — Spectre 対策によるタイマー
精度低下は「実 I/O が発生するまでは時刻が前進しない」という凍結 caveat（既存の実測記録、A4b 追補
「retry backoff の実時間は本サンドボックスでは観測不能」と同種の制約）を引き継ぐ。二重管理の役割分担
（一次 = platform 公表値、相関用 = 自前差分）は Haddock に明記する（裁定 7）。

### 決定 5: error level は sampleRate に関係なく常時 emit（裁定 3）

head sampling（`loggerConfigSampleRate`）は info/debug レベルのログ量削減が趣旨であり、**error
レベルは sampleRate の値に関係なく常時 emit する**。

### 決定 6: `LogSink`/`deferredSink` は外部 sink 拡張点の型のみ

外部 APM（Sentry 等）への送信実装自体は本 theme のスコープ外のまま据え置く。`LogSink`/`deferredSink`
は `waitUntilOn`（[ADR-0011](./0011-outbound-http-fetch-backend.md)）経由で使える拡張点として**型のみ**
用意し、具体的な送信先実装は将来のフォローアップとする。

### 決定 7: lint gate = `scripts/verify-console-boundary.sh`

遵守事項「ログ出力は `Logger` 層経由のみとし、ハンドラ内の直接 `console.*` JSFFI 呼び出しを禁止する
（grep/lint で検査）」の実体化として、`scripts/verify-console-boundary.sh` を新設する。`console.*` の
JSFFI 呼び出しは **`Internal/FFI/Reactor.hs` のみ許可**し、それ以外での直接呼び出しを機械的に検出
する。batch A6-4（U10）で実装予定。

### 決定 8: 256KB/req ログ予算・Free plan 制限を設計制約として記録

Workers Logs は 1 リクエストあたり 256KB のログ予算を持ち、Free plan は保持期間 3 日・上限 20 万
イベント/日という制限を持つ。これらは自前ロガーの設計制約として記録し、ホットパスでの過剰なログ出力
を避ける根拠（本文「決定」節が既に述べる「レベルでガード」）を補強する。

### 決定 9: error taxonomy — 既存 6 + 実査判明 2 + 新設 2、umbrella 型なし、封筒化の全面化

taxonomy は次の 10 型に確定する。**umbrella 型は設けない**（各例外型は独立した `Exception` インスタン
スのまま）。

| 分類 | 由来 |
| --- | --- |
| `ServerError` | servant-server（[ADR-0006](./0006-servant-execution-engine.md)） |
| `BindingMissingError` | env 構築時の binding 全数検査（[ADR-0008](./0008-cloudflare-platform-bindings.md)） |
| `D1ExecutionError` | D1 封筒方式（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)、[ADR-0008](./0008-cloudflare-platform-bindings.md)） |
| `DOError` | DO storage（[ADR-0008](./0008-cloudflare-platform-bindings.md) 追補「A4 分」） |
| `AccessError` | Zero Trust JWT 検証（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md) 追補） |
| `FetchTransportError` | outbound fetch client（[ADR-0011](./0011-outbound-http-fetch-backend.md) 追補「決定 4」） |
| `QueueError`（実査判明） | Queue 送出（[ADR-0016](./0016-non-fetch-entrypoints.md) の Queues 送信側・消費側実装コード） |
| `ServiceBindingError`（実査判明） | `serviceFetch`（[ADR-0008](./0008-cloudflare-platform-bindings.md) 追補「A4 分・決定 3」） |
| `KVError`（新設） | A6 新設。呼び出しサイト分類 |
| `R2Error`（新設） | A6 新設。呼び出しサイト分類 |

`KVError`/`R2Error` の分類方式は **呼び出しサイト分類**（`QueueError`/`ServiceBindingError` と同じ
方式、3 対 1 の多数派 precedent）に確定した（裁定 5）。R2 の `onlyIf` オプション周りの扱いは U6/U7
実地確認で最終確定する（実装者報告待ち、本追補時点では未確定）。

**封筒化の全面化**: KV 全メソッド・R2 全メソッド・`d1All`/`d1First` について、返り値を封筒
（`{ok, value, kind, message}` 形式、[ADR-0011](./0011-outbound-http-fetch-backend.md) 追補「決定 4」
と同型）化する。根拠は上記の GHC documented semantics（safe import は thunk を返却、reject は force
時に発火）への構造的対策であり、**Step 0（U1）の実験結果に関わらず確定**する（crash 防止 + taxonomy
分類の両目的）。実装配置は [ADR-0008](./0008-cloudflare-platform-bindings.md)（KV/R2/D1 バインディング
実装）側になる見込みであり、**本追補は taxonomy 分類そのものの裁定を記録する**にとどめる。個別の
mapping 表（各コンストラクタ→HTTP ステータス→`logRecordErrorKind`）の全表は U6/U7 実装確定後、U13
整合確認時に本追補へ追記する。

### 実装状況（plan 確定時点の記録）

batch A6-0（Step 0 実験、U1/U2）が本追補と並行 dispatch 済み。決定 1（Logger 型）は batch A6-2（U8）、
決定 9 の封筒化は batch A6-1（U6、taxonomy 確定は U7 と並行）、決定 7 の lint gate は batch A6-4
（U10）がそれぞれ実装 Unit であり、本追補起票時点ではいずれも未着手。`LogRecord`/`LoggerConfig`/
`emitLog`/`verify-console-boundary.sh`/`KVError`/`R2Error` の実在・型検査通過・封筒化の実装完了は
本追補では確認していない。U13（batch A6-6 close）で整合確認する。

### 遵守事項への影響（plan 確定時点の解釈）

- 「ログ出力は `Logger` 層経由のみとし、ハンドラ内の直接 `console.*` JSFFI 呼び出しを禁止する
  （grep/lint で検査）。」→ **決定 7 の `scripts/verify-console-boundary.sh` で充足見込み**。lint
  実装・全 grep 対象箇所での実行結果は U13 で確認する（本追補時点では設計のみ）。

### 参考資料（追補分）

- [ADR-0012](./0012-middleware-equivalents.md) 追補（Tier1/Tier2 構成、適用順序表、
  `mapExceptionsToServerError` の境界）
- [ADR-0011](./0011-outbound-http-fetch-backend.md) 追補（封筒方式の先例、`FetchTransportError` 分類）
- [ADR-0008](./0008-cloudflare-platform-bindings.md) 追補（KV/R2/D1 実装、`serviceFetch`、封筒化の
  実装配置先）
- [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md) 追補（`AccessError`、構造化ログ化は A6 へ送付
  と既に明記済み）
- 実装詳細・裁定全文: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a6-plan.md`

### 実装確認 (2026-07-24, batch A6-6 U13)

batch A6-1（U6 封筒化）/A6-2（U7 taxonomy + U8 Logger）/A6-4（U10 lint gate）実装完了・全ゲート 2 連走
EXIT0（`~/.pschool/spikes/cloudflare-workers-hs-build/API-LEDGER.md` の A6 close item 15 参照）を受けて、
本追補の決定 1-9 を実コードと突合した。

- **決定 1**（Logger 型）: **差分あり**。`LogLevel` の実装コンストラクタ名は本追補ドラフトの
  `Debug | Info | Warn | Error` ではなく `LogDebug | LogInfo | LogWarn | LogError`
  （`skeleton/cloudflare-workers/src/Cloudflare/Workers/Observability.hs`）— 順序意味論（`Debug < Info
  < Warn < Error` 相当）自体は一致。`LogRecord` の `logRecordMethod`/`logRecordPath` は本追補ドラフトで
  は `Text`（必須）だが実装は `Maybe Text`（best-effort フィールド、Haddock: 「応答前など該当しない呼び
  出しサイトでは `Nothing`」）。`LoggerConfig` の 2 フィールド・既定値（`Info`/`1.0`）、単一 JSON object
  を `console.log` に渡す方式・文字列連結禁止は一致（`emitLog` の実装、`JSON.parse` 経由）。
- **決定 2**（`tailLog` 凍結存置）: 一致。signature 不変。
- **決定 3**（request id = cf-ray 継承 + `randomUUID` fallback、Handler 直読スコープ外）: 一致。
  `Middleware.hs` の `withRequestId`/`resolveRequestId` が本追補どおりに実装。
- **決定 4**（duration 二重管理）: 一致。`withStructuredLogging` 自身の Haddock が「★duration caveat」
  として同じ役割分担（platform 公表値が一次、`Date.now` 差分は相関用 best-effort）を明記。
- **決定 5**（error level 常時 emit）: 一致。`shouldEmitLog` の `level == LogError -> True` 分岐で実装。
- **決定 6**（`LogSink`/`deferredSink` は型のみ）: 一致。外部 sink 実装は本 theme でも未着手のまま（A6
  close の Remaining scope に記載）。
- **決定 7**（lint gate）: 一致。`scripts/verify-console-boundary.sh` 実装済み、`Internal/FFI/Reactor.hs`
  のみ allowlist、self-test 済み、U13 の 2 連走で EXIT0 確認済み。
- **決定 8**（256KB/req 予算記録）: 実装検証対象外（設計制約の記録のみ、対応するコード上のチェックポイ
  ントは無い）— 記録どおり据え置き。
- **決定 9**（error taxonomy 10 型・封筒化全面化）: 一致。`docs/error-taxonomy.md`（U7 新設）が本追補
  の 10 型テーブルと型名・由来とも完全一致。本追補が「本追補時点では未確定」としていた 2 点は、いずれも
  確定済み: (a) R2 `onlyIf` の扱い — `docs/error-taxonomy.md` row 5・`Binding/R2.hs` 実装で確定
  （`onlyIf` 不一致は非 throwing 三択 outcome のまま、`R2GetFailed` は真の reject 専用）。(b) 個別
  mapping 表（各コンストラクタ→HTTP ステータス→`logRecordErrorKind`）の全表 —
  `docs/error-taxonomy.md` の Table（10 行）が全表そのもの。本追補が予告していた「U13 時点で本追補へ
  追記」は、独立ファイル `docs/error-taxonomy.md` へ集約する形で充足させた（本追補本文への埋め込みは
  行わず、参考資料の相互参照リンクのみとした — 理由: 表が長大で ADR 追補に埋め込むと今後の更新のたびに
  二重メンテナンスが発生するため）。

**差分: 決定 1 の 2 点**（`LogLevel` コンストラクタ名 `Debug`→`LogDebug` 等、`LogRecord.logRecordMethod`/
`logRecordPath` の `Text`→`Maybe Text`）。いずれも実装時の妥当な変更と判断する（前者はプロジェクト全体
の命名規則 — 他の sum 型も bare な名前を避ける既存慣習との整合、後者は method/path が未確定な呼び出し
サイトへの防御的 `Nothing` 許容）であり、機能的な後退ではない。本 ADR 追補は append-only 慣習により本
文・既存決定は書き換えず、この確認セクションのみ追記する。

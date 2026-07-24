# ADR-0011: 送信 HTTP は fetch をバックエンドとする servant-client 解釈系を自前実装する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)

## 背景と課題 (Context)

実運用では外部 API 呼び出し（送信 HTTP）が要る。JWKS 取得（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）、
オリジン取得、外部サービス連携などである。標準的な `servant-client` は `http-client` を介し、
`http-client` は `network`（ソケット）に依存するため **`wasm32-wasi` でビルドできない**。WASI の
`sock_*` は `ENOSYS` で、そもそもソケットを開けない。一方 Workers では JS の **`fetch` API** が送信
HTTP を担い、TLS もランタイムが処理する。

本プロジェクトは自前実装方針のため、送信経路も外部ライブラリに依存せず、`fetch` をバックエンドとする
クライアント解釈系を自前で実装する。

## 決定要因 (Decision Drivers)

- ソケット不可（`ENOSYS`）の制約下で送信 HTTP を実現すること
- `servant-client` の型レベル API 記述を再利用できること（型共有・DRY）
- async JSFFI（Promise/`await`）で `fetch` を扱えること
- TLS をランタイムへ委譲し、Haskell に TLS スタックを持ち込まないこと

## 検討した選択肢 (Considered Options)

1. **`servant-client-core`（純 Haskell）を再利用し、`fetch` を呼ぶ `RunClient` バックエンドを自前実装する**
2. `servant-client` + `http-client` をそのまま使う
3. 送信を都度 JSFFI で `fetch` 直書きし、型付きクライアント抽象を設けない

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- `servant-client-core`（`network` 非依存・純 Haskell）を再利用し、その `RunClient` 抽象に対する
  バックエンドを、JSFFI（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）の `fetch`/`Request`/`Response` で
  自前実装する。これにより API 型から送信クライアントを導出でき、サーバ側（[ADR-0006](./0006-servant-execution-engine.md)）と型を共有できる。
- リクエスト本文・ヘッダ・メソッド・クエリを `fetch` の `Request` へ写し、応答を `Response` から読み出す。
  本文はストリーミング（[ADR-0007](./0007-streaming-readablestream.md)）を尊重する。
- **TLS はランタイムが担う**ため、Haskell 側に TLS 実装を持たない。
- 既存の `servant-client-fetch`（Fetch API を JSFFI で backend にする先行例）は **設計参照のみ**とし依存しない。
- Service Bindings 経由の Worker 間呼び出し（[ADR-0008](./0008-cloudflare-platform-bindings.md)）も、同じ
  クライアント抽象から扱えるよう整合させる。
- **タイムアウト/リトライ/中断**: `fetch` には `AbortSignal` ベースのタイムアウトを既定で付与し、リトライは
  **冪等メソッドに限定**して指数バックオフを適用する。サブリクエスト上限（無料 50/リクエスト、
  [ADR-0014](./0014-bundle-size-limits-performance.md)）の超過は専用エラー型で表す。

## 結果 (Consequences)

### 良い結果 (Positive)

- ソケット不可の制約下でも送信 HTTP を実現でき、JWKS 取得や外部連携が可能になる。
- API 型をサーバと共有でき、`servant-client` 流の型安全なクライアントが得られる。
- TLS をランタイムに委譲でき、依存とバンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）を抑えられる。

### 悪い結果・トレードオフ (Negative)

- `http-client` 固有の機能（コネクションプール、低レベルタイムアウト制御等）は使えず、`fetch` の
  できる範囲に縛られる。
- `RunClient` バックエンドの実装・互換テスト工数。

### 中立・フォローアップ (Neutral / Follow-up)

- `fetch` のオプション（`cf` プロパティ、キャッシュ制御、リトライ）をクライアント抽象にどう露出するか設計する。
- Service Bindings RPC とプレーン `fetch` を同一抽象で扱う際の差異を吸収する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `servant-client-core` 再利用 + `fetch` バックエンド（自前）

- 利点: ソケット不要・型共有・TLS 委譲・依存最小。方針と整合。
- 欠点: `http-client` の低レベル機能は不可、実装工数。

### `servant-client` + `http-client`

- 利点: 既存実装をそのまま使える。
- 欠点: `network` 依存で **ビルド不能**。ソケットも `ENOSYS`。採用不可。

### 都度 `fetch` 直書き

- 利点: 前準備が最小。
- 欠点: 型安全性が低く重複が多い。サーバとの型共有が得られない。

## 遵守事項 (Compliance)

- [ ] 送信は `fetch`（JSFFI）を用い、`http-client`/`network`/ソケットへ依存しない。
- [ ] クライアントは `servant-client-core` を入力に取り、API 型をサーバと共有する。
- [ ] TLS スタックを Haskell 側に持ち込まない。
- [ ] 送信にはタイムアウト（AbortSignal）を付与し、リトライは冪等メソッドに限定する。

## 参考資料 (References)

- Haskell Discourse — Blog system on Cloudflare Workers（`servant-client-fetch` が Fetch を backend に）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- @cloudflare/workers-wasi（ソケット syscall は ENOSYS）: https://www.npmjs.com/package/@cloudflare/workers-wasi
- GHC User's Guide — WebAssembly backend（async JSFFI / Promise）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html

## 追補 (2026-07-23): Phase A theme A4b で確定した `servant-client-core` 再利用方式・`RunClient` バックエンド実装

- ステータス: 承認（追補）
- 日付: 2026-07-23
- 決定者: lihs

Phase A theme A4b（`servant-cloudflare-workers-client` の最後の stub 面 = client 9 stub 全撤去、実機検証済み）
で確定した設計を記録する。本文「決定 (Decision)」節は当初、送信クライアントの導出方式を明記していな
かった（「`servant-client-core` を再利用し `RunClient` 抽象へバックエンドを自前実装する」とだけ述べ、
combinator dispatch 自体を再導出するかは未確定だった）。以下のとおり実装レベルで確定する。本文自体は
書き換えない。

### 決定 1: instance 導出は `servant-client-core` の `HasClient`/`clientIn` を直接再利用（並行 class は削除）

spike には `HasWorkerClient` という並行 class（`HasClient` 相当を簡略化した 7 stub instance）が存在し
たが、これは **`Servant.Cloudflare.Workers.Client` モジュールごと完全に削除**した。研究 3 体 + synthesizer
を経た orchestrator 裁定（★B 案）により、本パッケージは real `servant-client-core` 0.20.3.0 自身の
`HasClient`/`clientIn` をそのまま再利用する。自前実装として残るのは `instance RunClient FetchClient` と
Fetch FFI 層のみであり、これは本文が当初から明記していたスコープ（「`servant-client-core` を再利用し
`RunClient` 抽象へのバックエンドを自前実装する」）そのものである。

根拠:

- `servant-client-core` は依存が全て pure Haskell（`network`/`http-client` 非依存）であり、この推移
  閉包が `wasm32-wasi` でビルド通過することを実証済み（`dist-newstyle/build/wasm32-wasi/` に client
  package の `.so`/`.a` が実在）。
- combinator dispatch（`Capture`/`QueryParam`/`Header`/`ReqBody`/`:<|>` 等の型レベル解釈）を手書きで
  再導出すると、real `HasClient` インスタンスとの conformance を人手で維持し続ける必要がある。real
  instance をそのまま使えば conformance は構築的に担保される。
- combinator surface がサーバ側（[ADR-0006](./0006-servant-execution-engine.md)）と対称化される —
  サーバ側も real `servant-server` の型クラスをベースにしている。

`clientIn` 経路の全鎖（`clientIn` → real `HasClient` generic instance → `RunClient FetchClient`
instance（default options）→ 封筒化された `fetch()` → `MimeUnrender` decode + 非 2xx `FailureResponse` +
`:<|>` 分岐）を end-to-end で実証済み。`AllowAmbiguousTypes` は不要だった（呼び出し箇所での明示的な型
注釈 pin で型推論が解決した）。

### 決定 2: `RunClient` バックエンドの確定形 — `FetchClient` / `FetchClientOptions` / タイムアウト実装

```haskell
newtype FetchClient a = FetchClient { runFetchClient :: BaseUrl -> IO a }

data FetchClientOptions = FetchClientOptions
  { fetchClientOptionsTimeoutMillis :: Int
  , fetchClientOptionsMaxRetryAttempts :: Int
  , fetchClientOptionsRetryBaseDelayMillis :: Int
  } deriving (Show, Eq)

defaultFetchClientOptions :: FetchClientOptions
defaultFetchClientOptions = FetchClientOptions
  { fetchClientOptionsTimeoutMillis = 10000
  , fetchClientOptionsMaxRetryAttempts = 2
  , fetchClientOptionsRetryBaseDelayMillis = 250
  }
```

`FetchClientOptions`/`defaultFetchClientOptions` は **公開 API**（timeout/retry の production knob）。
`instance RunClient FetchClient` 自体は `defaultFetchClientOptions` を使う薄いラッパである
（`runRequestAcceptStatus acceptStatus request = FetchClient (\baseUrl -> fetchWithOptions
defaultFetchClientOptions acceptStatus baseUrl request)`）。デフォルト値（10000ms / 2 回 / 250ms）は
当初暫定としていたが、A4b U6 の実測（spy-mocked `fetch()` が即応答する条件下で T2 全体の wall-clock
コストに測定可能な影響なし、8.48s→8.56s）で production-reasonable と確定した。

タイムアウトは `AbortController` + 手動 `setTimeout` で実装する。`AbortSignal.timeout()` は使わない —
ローカル workerd 実行環境で uncatchable `DOMException` を投げるバグ（cloudflare/workerd#1020）を踏むため
である。**`controller.abort()` は引数なしで呼ぶ**（`abort('timeout')` のように reason 付きで呼ぶと、
reject される例外が `AbortError` にならず reason 文字列がそのまま飛ぶ — orchestrator 設計指摘、実装前に
発見・回避）。

### 決定 3: retry 意味論 — 冪等メソッド限定 + transport 失敗のうち timeout/network のみ

```haskell
isIdempotentMethod :: Method -> Bool -- ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"] への生バイト比較

shouldRetryTransportError :: FetchTransportError -> Bool
-- True: FetchTimedOut / FetchNetworkFailure
-- False: FetchSubrequestLimitExceeded
```

retry は次の 3 条件を**すべて**満たす場合にのみ、指数バックオフ（`fetchClientOptionsRetryBaseDelayMillis
* 2 ^ attemptIndex`、`jsDelayMillis` で sleep）を挟んで行う: (1) `isIdempotentMethod` が真、(2) 分類され
た transport エラーが `shouldRetryTransportError` で真、(3) `1 + fetchClientOptionsMaxRetryAttempts` 回の
試行予算が未消尽。いずれか 1 つでも欠ければ即座に `ConnectionError` を投げる。

**subrequest 上限超過（`FetchSubrequestLimitExceeded`）は retry しない**。同一 request context 内での
再試行はプラットフォームの per-request subrequest 上限に既に達している状態からは成功し得ず、消尽済みの
予算をさらに浪費するだけである（orchestrator 裁定、実装判断の余地なし）。

**非 2xx 応答（`FailureResponse`）も retry しない**。これは transport 障害ではなく確定した応答であり、
`throwUnlessAcceptableStatus` による非 2xx チェックは **retry ループが既にある試行の envelope 成功を
確定させた後に**厳格に実行する（`FailureResponse` が retry の対象になることは決してない）。

### 決定 4: エラー分類 — `FetchTransportError` を `ConnectionError` に包む、subrequest-limit 判定は文字列マッチ

```haskell
data FetchTransportError = FetchTimedOut | FetchSubrequestLimitExceeded | FetchNetworkFailure Text
  deriving (Show, Eq)
instance Exception FetchTransportError

classifyFetchTransportError :: Text -> Text -> FetchTransportError
-- kind="timeout" -> FetchTimedOut / kind="subrequest-limit" -> FetchSubrequestLimitExceeded
-- それ以外 -> FetchNetworkFailure message（全域関数）

classifyEnvelopeFailure :: (Text, Text) -> ClientError
classifyEnvelopeFailure (kind, message) = ConnectionError (toException (classifyFetchTransportError kind message))
```

`ClientError`（`servant-client-core` 側の型）は閉じた sum であり改変できないため、既存の `ConnectionError`
コンストラクタへ包むのが唯一の選択肢である。JS 側の封筒は `{ok, value, kind, message}` の 4 値。
subrequest-limit の判定は JS 側エラーメッセージへの正規表現ベストエフォート・マッチ（`/too many
subrequests/i`）で行う — **プラットフォーム側のエラー文言変更に脆弱であることを Haddock に明記済み**。

### 決定 5: conformance oracle — `Servant.Client.Free` で正典 `Request` を host 上で純粋 inspect

URL/ヘッダ構築（`buildFetchTargetUrl`/`requestHeadersToWorkersHeaders`）は JSFFI を一切持たない純粋
module（`Servant.Cloudflare.Workers.Client.Fetch.Request`）へ分離した。この分離こそが conformance oracle
の成立条件である — `test/Conformance.hs` は `Servant.Client.Free` から導出した正典 `Request` を、real
`servant-client` の JS/ソケットバックエンドを経由せず host GHC 上で純粋に inspect できる。Toy API
（`Capture`+`QueryParam`+`Header`+`ReqBody`+`:<|>` を必須とし `QueryFlag`/`QueryParams`/percent-encoding
Capture 等の encoding が異なる combinator を任意追加）を対象に **8/8 一発 GREEN** — 19 branch 全網羅は
不要という裁定を厳密解釈した結果である。実装は T2 157 passed（+1 skipped、baseline 145 から +12）で
全ゲート EXIT0 を確認済み。

### 実測で確定した挙動（記録）

- **`fetchMock`（`import { fetchMock } from "cloudflare:test"`）は `@cloudflare/vitest-pool-workers`
  0.13.0 で撤去済み**であり、本リポジトリの pin（0.18.7）には存在しない。当初 A4b 計画は旧 API
  （`fetchMock.activate()` + `disableNetConnect()` + `intercept().reply()`）を前提としていたが、これは
  実行時点で既に stale だった。**公式代替は `vi.spyOn(globalThis, 'fetch')`**（本リポジトリの
  `@cloudflare/vitest-pool-workers` fixture 例と同じパターン）。テスト実務上の注意点として、
  **`afterEach(vi.restoreAllMocks())` が必須**である — assert の throw は trailing の `mockRestore` を
  飛ばし、isolate は `it` 間でリセットされないため、spy が次のテストへ漏れる。
- retry backoff の実時間は本サンドボックスでは観測不能（時間凍結 artifact の 6 例目）。期待
  `~750ms`（`250 * (2^0 + 2^1)`）に対し実測 `~13ms`。そのため retry 検証は spy の呼び出し回数のみを
  assert し、経過時間の assert は行わない。

### 遵守事項への影響（本文 override）

- 「クライアントは `servant-client-core` を入力に取り、API 型をサーバと共有する。」→ **追補により
  具体化**: 「入力に取る」の実装は `HasClient`/`clientIn` の直接再利用であり、並行する自前 class は
  持たない（決定 1）。
- 「送信にはタイムアウト（`AbortSignal`）を付与し、リトライは冪等メソッドに限定する。」→ **追補に
  より具体化**: タイムアウトは `AbortController` + 手動 `setTimeout`（`AbortSignal.timeout()` は不採用、
  決定 2）。リトライは冪等メソッド限定に加え、transport 失敗のうち timeout/network のみを対象とし、
  subrequest-limit と非 2xx は明示的に対象外とする（決定 3）。

### 中立・フォローアップ（本文「結果」節）への影響 — 未充足の明記

- 本文「決定」節が述べた「本文はストリーミング（[ADR-0007](./0007-streaming-readablestream.md)）を
  尊重する」は **A4b の時点では未充足**。`RequestBodySource`（ストリーミングリクエストボディ）は
  `Internal.FFI.Fetch.fetchViaFFI` 内で `error`（A7 の `RunStreamingClient` スコープへ送付済み）であり、
  現状の送信ボディは非ストリーミングのみをサポートする。
- 本文「中立・フォローアップ」が挙げた 2 点（`fetch` の `cf` プロパティ・キャッシュ制御をクライアント
  抽象へどう露出するか／Service Bindings RPC とプレーン `fetch` の統一抽象）は、A4b のスコープ外として
  **引き続き未決**のまま据え置かれた。

### 参考資料（追補分）

- [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) 追補（JSFFI 境界の実装規約 — safe/unsafe 割当・
  JS 側 try/catch 封筒）
- [ADR-0006](./0006-servant-execution-engine.md)（サーバ側 `HasServer` との combinator surface 対称性）
- [ADR-0007](./0007-streaming-readablestream.md)（送信ボディのストリーミング — A7 送りの根拠）
- cloudflare/workerd#1020（`AbortSignal.timeout()` のローカル workerd 実行時 uncatchable `DOMException`）
- 実装詳細・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a4b-plan.md`、
  `_phase_b/divergence-notes.md`「A4b」節、`API-LEDGER.md` item 13（"A4b close"）

## 追補 (2026-07-24): Phase A theme A7 Unit c1/c2 で確定した `RunStreamingClient`/`RequestBodySource` 着地

- ステータス: 承認（追補）
- 日付: 2026-07-24
- 決定者: lihs（streaming upload 必達への格上げは lihs 裁定、a7-plan.md 要裁定 1）

本文「中立・フォローアップ」節および A4b 追補が「A4b の時点では未充足」としていた 2 点
（`RunStreamingClient`、`RequestBodySource` のストリーミング）を、Phase A theme A7 Unit c で
実装・確定する。本文・A4b 追補は書き換えない。

### 決定 6: `RunStreamingClient FetchClient` — 応答ボディの段階受信（Unit c1）

`Servant.API.Stream.Stream` combinator の `HasClient` instance が要求する `RunStreamingClient m`
制約が本パッケージに存在しなかったため、`StreamGet`/`StreamBody'` を使う API 型は `clientIn` の
**型検査自体が失敗**していた（実行時 stub ではなくコンパイル時のギャップ）。

```haskell
instance RunStreamingClient FetchClient where
  withStreamingRequest request handleStreamingResponse =
    FetchClient (\baseUrl -> dispatchStreamingRequest baseUrl request handleStreamingResponse)
```

`dispatchStreamingRequest` は `fetchStreamingViaFFI`（新規、`fetchViaFFI` と request 構築・envelope
dispatch を共有し、応答ボディのみ `.arrayBuffer()` 全量ドレインでなく
`Cloudflare.Workers.Internal.FFI.Stream.readableStreamGetReaderViaFFI`/`readableStreamReaderReadViaFFI`
（A7 Unit b の response-push bridge 実装時に既に private だった `getReader`/`read` primitive を
このユニットで export・cross-package 再利用）による pull ループへ差し替え）を呼ぶ。応答 status の
accept 判定は real servant-client の `RunStreamingClient` backend
（`Servant.Client.Internal.HttpClient.Streaming.performWithStreamingRequest`）に倣い
`statusIsSuccessful` を hard-code（`Stream` combinator 自身に acceptStatus 引数が無いため）、
非 2xx はボディを `Servant.Types.SourceT.runSourceT` で全量ドレインしてから `FailureResponse` を
構築する（real servant-client と同じ形）。

mid-stream の server 側失敗（`controller.error`）は、JS `read()` の reject を
`Cloudflare.Workers.Internal.FFI.Envelope` と同じ封筒化パターンで捕捉し（この reject を素の `safe`
import + Haskell 側 `try` で捕まえようとすると ADR-0003 が確立した理由と同じく `rts_promiseReject`
を素通りする）、`Servant.Types.SourceT.Error` として client 側 `SourceT` に忠実に写す。

### 決定 7: `RequestBodySource` — 真のストリーミングアップロード必達（Unit c2、lihs 裁定で格上げ）

`Internal.FFI.Fetch.fetchViaFFI` 内で `error "unimplemented (A7 scope)"` だった
`RequestBodySource`（ストリーミングリクエストボディ）分岐を解消する。当初の planner 推奨は
「buffer-drain を base 必達・真のストリーミングは余力次第の stretch」だったが、**lihs 裁定によりストリーミングアップロードを必達へ格上げ**した（Step 0 probe (iii) で `fetch(url, {
body: ReadableStream, duplex: 'half' })` が実機で機能することを確認済みだったため）。

```haskell
requestBodyToPayload :: RequestBody -> IO RequestBodyPayload
requestBodyToPayload (RequestBodyLBS lazyBytes) = pure (RequestBodyPayloadBytes (LazyByteString.toStrict lazyBytes))
requestBodyToPayload (RequestBodyBS strictBytes) = pure (RequestBodyPayloadBytes strictBytes)
requestBodyToPayload (RequestBodySource sourceIO) =
  RequestBodyPayloadStream . readableStreamToJSVal
    <$> Cloudflare.Workers.Streaming.readableStreamFromProducer (produceRequestBodyChunks sourceIO)
```

`readableStreamFromProducer`（A7 Unit b が server push 用に新設した Haskell-produces/JS-consumes
bridge）をそのまま転用し、`produceRequestBodyChunks` は server 側 `renderStreamResult` の
`produceFramedChunks` と同型の `SourceT` unroll をクライアントパッケージ側に独立実装する（client は
server package に依存してはならないため、~15 行のコードを共有せず複製する設計判断）。
`new Request($1, { ..., body: $4, duplex: 'half' })` — **`duplex: 'half'` はローカル実行環境が
強制しなくても常に付与する**（実 edge の Fetch 仕様準拠のため、ローカル workerd の寛容さに頼らない）。

### 決定 8: streaming request body は retry 対象から除外する（orchestrator 指摘、実装中に発覚した罠）

`fetchWithOptions` の retry ループは `RequestBodySource` の `SourceT` を **同一の未消費値へ再度
`unSourceT` を呼んで**再送しようとする — 一般に単一消費の CPS 値（ファイルハンドル等を閉じるような
リソースを内部に持つ source は典型例）を 2 回走らせる保証はなく、再試行のたびに空または壊れた
body を送りかねない。`requestBodyIsStreaming :: Request -> Bool` を新設し、`fetchWithOptions` の
retry 判定に `isIdempotentMethod`/`shouldRetryTransportError`/試行予算と並ぶ **第4の必須条件**として
追加した（`RequestBodySource` の body は method に関わらず retry しない — `StreamBody'` は
冪等メソッドに型レベルで制限されないため、`PUT` 等の冪等メソッドでも streaming body なら
retry してはならない）。T1（`requestBodyIsStreaming` の純関数テスト）・T2
（常に reject する `fetch()` mock に対し streaming body の PUT が 1 回しか dispatch されないことを
確認、非 streaming の同条件は 3 回まで retry する既存 `fetch-client-retry.spec.ts` と対比）で検証済み。

### 決定 9: fetch abort/reject 時にリクエストボディの `ReadableStream` を明示的に cancel する（実機で反証されたプラットフォーム前提）

Unit c2 着手時、「fetch の abort/reject 時に body の `ReadableStream` は自動的に cancel される」と
仮定していたが、**実機検証で反証**した（`streaming-upload-abort-cancel-probe.spec.ts`:
未消費の `ReadableStream` を body に持つ `fetch()` を abort させても、その stream の `cancel()` は
一切呼ばれない — この workerd/wrangler pin、`1.20260721.1`/`4.113.0`）。反証しなければ
`readableStreamFromProducer` の producer thread（`jsPullEnvelopeAwaitDemand` で待機中）が
永久に park し続けるリーク（A7 Unit b が応答方向で文書化した leak limit のアップロード方向版、
今回は受信側でなく `fetch()` 自身が早期に諦めることが引き金）になる。

対策として `jsFetchEnveloped`（`Internal.FFI.Fetch.hs`）の catch 節に
`try { if ($1.body) { await $1.body.cancel(); } } catch {}` を追加した（あらゆる reject 経路 —
timeout・network・subrequest-limit — で best-effort 実行、既にロック済み/消費済みの body への
cancel が投げても本来の envelope 分類を隠さないよう try/catch で保護）。

### 実測で確定した挙動（記録）

- **`RunStreamingClient FetchClient` 不在時の RED**: `No instance for
  'Servant.Client.Core.RunClient.RunStreamingClient FetchClient' arising from a use of 'clientIn'`
  （`test/Spec.hs` の `toyStreamClient` 型検査で実機確認、instance 追加で GREEN）。
- **fetch abort 時の request body ReadableStream 自動 cancel は存在しない**（決定 9 参照、実機確認）。
  duplex 未強制のローカル寛容さ（A7 Step 0 probe (iii)）とは別種の、確認して初めて分かった
  プラットフォームギャップ。
- T2 実測: client 側 incremental 受信（3 chunk、chunk 間 timing gap ≥30ms 観測）・streaming upload
  （3 fragment 分割 POST が実 `/shorten` ハンドラ + 実 KV へ到達、read 間 timing gap ≥15ms 観測）・
  streaming body retry 拒否（mock 1 回のみ dispatch）・abort/cancel 実測、全て初回 GREEN
  （baseline 195+1skip → 200+1skip）。

### 遵守事項への影響（本文 override）

- 「本文はストリーミング（ADR-0007）を尊重する」（A4b 追補が「未充足」としていた点）→
  **本追補で充足**: 応答ボディは決定 6 の pull-driven `SourceT`、要求ボディは決定 7 の
  push-driven `readableStreamFromProducer` 経由でどちらも真のストリーミング。

### 参考資料（本追補分）

- [ADR-0007](./0007-streaming-readablestream.md)（`readableStreamFromProducer` の元設計、A7 Unit b）
- `Cloudflare.Workers.Internal.FFI.Envelope`（reject を Haskell `try` で捕まえられない toolchain 制約、
  decision 6 の封筒化がこの precedent を再利用する根拠）
- 実装詳細・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a7-plan.md`
  「### Unit c」節、`API-LEDGER.md` の `servant-cloudflare-workers-client` セクション（A7 Unit c 追記分）

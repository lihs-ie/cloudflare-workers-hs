# ADR-0007: リクエスト/レスポンス本文は ReadableStream を素通しでストリーミングする

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0005](./0005-http-layer-no-wai.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0014](./0014-bundle-size-limits-performance.md)

## 背景と課題 (Context)

Cloudflare Workers は本文を `ReadableStream` として授受し、`Response` も `ReadableStream` を本文に取れる。
本ライブラリは WAI を介さず直接 `Request`/`Response` を扱う（[ADR-0005](./0005-http-layer-no-wai.md)）ため、
本文の表現とストリーミング方針を定める必要がある。Servant には `StreamGet`/`StreamBody` 等の
ストリーミング組み合わせ子があり、これらを Workers のストリームへどう写すかも論点となる。

短い CPU 予算・限られたメモリ（[ADR-0014](./0014-bundle-size-limits-performance.md)）下では、
大きな本文を Haskell ヒープへ全量バッファリングするのは不利であり、可能な限りストリームのまま
流すことが望ましい。

## 決定要因 (Decision Drivers)

- 大きな本文を全量バッファせずに扱えること（メモリ・CPU 予算）
- 変換コストを最小化し `ReadableStream` を素通しできること
- Servant のストリーミング組み合わせ子と整合する API を提供できること
- async JSFFI（Promise/`await`）でのチャンク読み出しに対応できること

## 検討した選択肢 (Considered Options)

1. **本文を `ReadableStream` のまま保持し、素通し優先・必要時のみ取り込む遅延表現にする**
2. 受信時に本文を全量バイト列へ取り込み、送信時も全量から `Response` を作る
3. 本文を独自のチャンク列（pull 型イテレータ）へ常時変換して扱う

## 決定 (Decision)

採用する選択肢: **選択肢 1（`ReadableStream` 素通しを既定、明示時のみ取り込み）**

- 受信本文は既定で `ReadableStream` ハンドル（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) のバインディング型）として保持し、
  ハンドラが JSON/テキスト/バイト列として**明示的に要求したときだけ** `await` で取り込む。
- 応答本文は、(a) 小さい確定値はバイト列、(b) 大きい/ストリーミングは `ReadableStream` を**そのまま** `Response` に渡す、
  の 2 経路を用意する。プロキシ的にアップストリームの `ReadableStream` を下流へ素通しできるようにする。
- Servant の `StreamBody`/`StreamGet` 等は、この `ReadableStream` 素通し経路へ写像する解釈を
  サーバ解釈系（[ADR-0006](./0006-servant-execution-engine.md)）に実装する。チャンク読み出しは
  async JSFFI（Promise/`await`）で表現する。
- **本文サイズ上限**: 明示取り込み（`await` で JSON/バイト列化）には既定の最大バッファサイズを設け、超過時は
  **413 (Payload Too Large)** を返す。128 MB メモリ・短い CPU 予算（[ADR-0014](./0014-bundle-size-limits-performance.md)）下での
  無制限取り込みによるメモリ/CPU 枯渇を防ぐ。入力検証はデコード段の前後に配置する。

## 結果 (Consequences)

### 良い結果 (Positive)

- 大きな本文でもメモリを節約でき、変換コストを避けて CPU 予算を守れる。
- アップストリーム（R2/オリジン/Service Binding）からのストリームをプロキシ的に下流へ流せる。

### 悪い結果・トレードオフ (Negative)

- ストリームは基本「一度しか読めない」ため、本文を複数回参照する処理（再試行・署名検証など）は
  明示的な取り込み（バッファ）を要し、設計上の注意が必要。
- async（Promise）境界がハンドラ内に増え、単一スレッド RTS・`WouldBlockException`（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）の制約と整合させる必要がある。

### 中立・フォローアップ (Neutral / Follow-up)

- 「取り込み済みバイト列」と「未読ストリーム」を型で区別し、二重読みを型レベルで防ぐ設計を検討する。
- バックプレッシャ/チャンクサイズの既定値は実測（[ADR-0014](./0014-bundle-size-limits-performance.md)）で調整する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `ReadableStream` 素通し（既定）+ 明示取り込み

- 利点: 省メモリ・低変換コスト・プロキシ素通し。Workers の実態に最適。
- 欠点: 一度しか読めない制約への配慮が必要。

### 常時全量バッファ

- 利点: 実装が単純で本文を何度でも読める。
- 欠点: 大きな本文でメモリ・CPU を浪費。Workers 制約に反する。

### 常時チャンク列へ変換

- 利点: 抽象が一貫。
- 欠点: 素通しできず変換コストが常に乗る。`ReadableStream` を直接渡せる利点を捨てる。

## 遵守事項 (Compliance)

- [ ] 受信本文は既定でストリームとして保持し、要求時のみ取り込む。
- [ ] 応答本文に `ReadableStream` をそのまま渡せる経路を提供する（全量バッファを強制しない）。
- [ ] ストリームの二重読みを行わない（必要時は明示取り込み結果を再利用する）。
- [ ] 明示取り込みには最大バッファサイズの上限を設け、超過時は 413 を返す。

## 参考資料 (References)

- Cloudflare Workers — Streams API: https://developers.cloudflare.com/workers/runtime-apis/streams/
- Haskell Discourse — Blog system on Cloudflare Workers（ReadableStream 素通しの動機）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- GHC User's Guide — WebAssembly backend（async JSFFI）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html

## 追補 (2026-07-24): A7 Unit a/b — chunk 境界保存の実測と server 側 incremental 配信の設計確定

- ステータス: 承認（追補・実装済み、全ゲート EXIT 0）
- 日付: 2026-07-24
- 決定者: lihs（theme A7 実行編成に基づく実装時決定の記録。実装 = A7 Unit b worktree）

### 実測 1（Step 0 probe (ii)）: workerd は enqueue 境界を素通しする

`/echo-stream`（zero-copy pass-through）へ 3 enqueue（17B / 64KiB / 3B）の `ReadableStream` を
POST し、応答を `read()` ループで観測した結果、**3 read()・各サイズ完全一致**（再チャンク化・
結合なし）。T2 常設 regression `examples/quickstart/test/integration/stream-chunk-boundary.spec.ts`
として commit 済み。帰結: server push 側の設計目標を「1 handler yield = 1 `controller.enqueue` =
1 consumer `read()`」に置けることが確定した（実際にそう実装され、
`stream-incremental.spec.ts` が end-to-end で検証している）。

### 決定 1: `renderStreamResult` の incremental 化は「pull 駆動 deferred-envelope ブリッジ」（dynamic export 不使用）

a7-plan の設計候補は P（push: `start(controller)` + `forkIO` + `desiredSize` 手動）と
Q（pull: `pull(controller)` を Haskell dynamic export にする）で、Q が第一候補だった。実装前に
本 toolchain（GHC 9.12.4 wasm）の `post-link.mjs` 生成 glue を実機検証したところ、
**literal Q は本プラットフォームで 2 つの lifecycle 問題を構造的に抱える**と判明した:

1. `"wrapper"` dynamic export は closure を `StablePtr` で pin し、その自動解放経路は JS 側
   `FinalizationRegistry` のみ（glue の該当行を確認）。**workerd は `FinalizationRegistry` を
   公開しない**（glue 自身の fallback は no-op registry）ため、明示 `freeJSVal` を全終端経路に
   差し込まない限り 1 stream = 1 closure リークになり、しかも consumer cancel 経路には
   `freeJSVal` を呼べる Haskell hook が存在しない。
2. `SourceT` は CPS（`unSourceT :: forall b. (StepT m a -> m b) -> m b`）であり、これは source が
   自身の消費全体を bracket で包めるようにするための形。独立に発火する pull callback から
   `StepT` を消費するには継続の dynamic extent から `StepT` を逃がす必要があり、bracket の
   release が消費完了前に走る。

採用した形（実装済み、`Cloudflare.Workers.Internal.FFI.Stream` の module Haddock が正）は
**Q の pull 駆動 backpressure 意味論を保ったまま、demand 信号を ADR-0003/A1 実証済みの
deferred-envelope + `forkIO` パターン（`Internal/FFI/Reactor.hs` の `ctxWaitUntilViaFFI` と同型）
で実装する**もの:

- `pull` は純 JS: demand deferred を resolve し、producer が enqueue 完了時に resolve する
  「pull 完了 Promise」を返す（Streams 仕様がこの Promise で pull を直列化するため、
  spin も並行 pull も構造的に起きない）。
- producer は stream ごとに 1 本の `forkIO` green thread が `unSourceT` の継続内で全消費
  （bracket の dynamic extent = thread の生存期間）。demand 待ちは `safe` import の
  Promise await（1 green thread のみ suspend）。
- `StablePtr` はどこにも存在しない → `FinalizationRegistry` 不要、`freeJSVal` の手動タイミング
  管理も不要。cancel は demand deferred 経由で producer を起こして退出させる。
- backpressure: 既定 queuing strategy（highWaterMark 1）の pull サイクルが consumer 需要を
  そのまま体現する。メモリ保持は JS queue ≤ 1 chunk + Haskell 側先行生産 ≤ 1 chunk に有界
  （eager-drain の全量バッファは消滅）。
- P へのフォールバック条件（同一障害 2 回)には到達しなかった。`desiredSize` 手動チェックは
  結果として一切不要。

servant 側は `renderStreamResult` が未 drain の framed `SourceT` を
`Cloudflare.Workers.Streaming.readableStreamFromProducer` へ渡し、即座に
`ResponseBodyStream` で応答する（`produceFramedChunks` = StepT unroller、T1 で純粋部分を網羅）。

### 決定 2: mid-stream 失敗の写像（A6 封筒化との整合）

- `StepT.Error` / `Effect` 中の Haskell 例外 → `controller.error(new Error(displayException 文))`。
  以後の consumer `read()` は必ず reject する（silent truncation = 「途中で切れているのに
  `done: true`」を構造的に排除。A6 の never-silent 規律の stream 版）。
- HTTP status は最初の chunk 生産前に 200 でコミット済みのため、mid-stream 失敗が status に
  なることはない（eager 時代の「drain 中エラー → 500」は消滅。real servant-server の
  mid-body abort と同じ観測面に一本化）。
- `controller.error()` は Streams 仕様上**自 queue の未読 chunk を破棄する**（実測で再現）ため、
  error は demand-gate する（自 controller に未読 chunk が残る間は error しない）。
- ★実測 platform 限界: `new Response(stream)` の workerd 内部 pump は source error 時に
  **pump 自身のバッファも破棄する**ため、in-process 直呼び経路（vitest-pool-workers の
  `worker.fetch` / service-binding dispatch）では pre-failure chunk が consumer に届かないことが
  ある。実 HTTP hop では flush 済みバイトはワイヤ上にあり mid-body abort（Warp 同等）になる
  見込みだった — **pre-failure chunk の配信保証は下流 transport の性質**であり、本ブリッジは
  「自 controller の queue と error を race させない」ことまでを保証する。edge 実挙動の確認は
  theme 末 RE バッチ（client streaming RE と同一 deploy）に載せる。

  **★ RE 追補（2026-07-24、theme A7 close、Version `3e381073`）— 上記「見込み」は反証された**:
  実 HTTP hop 越しの mid-stream error は mid-body abort（Warp 風の途中切断）には**ならない**。
  実測結果は「**200 + 空 body + 正常 EOF**」— `read()` は一度も reject せず、pre-failure chunk
  も consumer に届かない。consumer は HTTP レイヤの観測だけでは、これを「正常に完了した空応答」
  と区別できない。帰結: **protocol-level framing（consumer 自身が検査する明示的な終端子/長さ）が
  唯一の誠実な integrity 手段**であり、下流 transport（workerd の Response pump、実 HTTP スタック
  いずれも）に completion の誠実性を委ねることはできない。この訂正は
  "Cloudflare.Workers.Internal.FFI.Stream" と
  "Servant.Cloudflare.Workers.Server.Internal"（`renderStreamResult`）の Haddock にも反映済み。
  Phase B の streaming 章では、この反証結果（mid-body abort ではなく silent 200+empty+EOF）を
  前提に protocol-level framing を教材化する必要がある（`_phase_a/a7-plan.md`
  「★RE バッチ実測結果」表を正とする）。

### 実測 2（Unit a）: backpressure 観察（遅い consumer 時に何が起きるか）

- 遅い consumer: pull が来ないため producer green thread は demand Promise 待ちで park する
  （CPU を消費しない）。JS queue には高々 1 chunk。`desiredSize` が負に育つことはない
  （enqueue が demand 応答時のみのため）。
- 読みも cancel もしない consumer: producer thread は isolate 終了まで park（documented limit —
  workerd は client 切断で body を cancel するため、通常の放棄経路は cancel 経路に合流する）。
- pass-through 経路（既存 `/echo-stream`）はそもそも Haskell を経由しないため、backpressure は
  全面的に workerd 内部の flow control に委ねられる（Haskell 側から制御する余地はない）。

### 遵守事項への影響

- 「Servant の `StreamBody`/`StreamGet` 等はこの `ReadableStream` 素通し経路へ写像する」—
  server 側 `Stream` combinator が本追補で実際にこの経路に乗った（buffered → incremental）。
- フォローアップ「バックプレッシャ/チャンクサイズの既定値は実測で調整する」— 既定
  highWaterMark 1 を T2 実測で妥当と確認（chunk サイズは handler の yield 粒度をそのまま保存）。

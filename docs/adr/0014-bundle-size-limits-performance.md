# ADR-0014: バンドルサイズ・CPU・メモリ制限を一級制約として設計する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0001](./0001-ghc-native-wasm-backend.md), [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md)

## 背景と課題 (Context)

Cloudflare Workers には実運用に効く厳しい制約がある。

- **バンドルサイズ**: Worker あたりの上限はプラン依存で、**無料枠 3 MiB / 有料 10 MiB（いずれも gzip 後）**、
  かつ**圧縮前 64 MB**（両プラン共通）（[Cloudflare Workers Limits](https://developers.cloudflare.com/workers/platform/limits/)、2026-06 時点）。
  GHC WASM 出力は圧縮前が大きくなりやすく、**圧縮前 64 MB が実効的な制約**になりやすい点に注意。
  なお先行事例（2024 年以前、当時の無料枠 1 MiB 制限下）は機能を 5 つの Worker に分割していた
  （Router ~995 / Database ~758 / Storage ~722 / Images ~664 / SSR ~977 KiB、圧縮後）が、これらは
  いずれも現行 3 MiB（無料）に収まる。**分割は当時の 1 MiB 制限の名残であり、現在は必須ではない**。
- **CPU 時間**: 1 リクエストあたり **無料枠 10ms / 有料 既定 30 秒（最大 5 分）**。無料枠は特に短い。
- **メモリ**: **isolate あたり 128 MB**（呼び出しごとではなく isolate 単位）。
- **サブリクエスト数**: 1 リクエストあたり **無料枠 50**、有料はそれより大幅に多い（プラン依存）。
  送信 HTTP（[ADR-0011](./0011-outbound-http-fetch-backend.md)）・`ctx.waitUntil` 内の通信・JWKS 取得
  （[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）はこの上限を消費する。
- **実行モデル**: 単一スレッド RTS（[ADR-0001](./0001-ghc-native-wasm-backend.md)）。**1 つの isolate は複数の
  リクエストを同時に処理しうる**ため、同時実行は RTS スケジューラ + async JSFFI でインターリーブされる。
  長命 isolate では線形メモリが単調増加しやすい（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）。

これらはライブラリ設計の各所（依存選定・ストリーミング・ログ量・機能分割）に影響するため、横断的な
方針として明文化する。

## 決定要因 (Decision Drivers)

- サイズ上限内に収め、必要なら機能分割でデプロイ可能にすること
- 短い CPU 予算内に処理を完了できること
- 長命 isolate でのメモリ単調増加に備えること
- 計測に基づいて最適化できること（憶測で削らない）

## 検討した選択肢 (Considered Options)

1. **サイズ/CPU/メモリを一級制約とし、依存最小化・`wasm-opt`/strip・機能の Worker 分割・計測を方針化する**
2. 制約を意識せず単一 Worker に全機能を載せ、超過時に都度対処する
3. パフォーマンスは後回しにし、まず機能網羅を優先する

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- **バンドルサイズ**: 依存を最小化（WAI/network/crypton を持ち込まない: [ADR-0005](./0005-http-layer-no-wai.md),
  [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）。リンク後に `wasm-opt`・不要シンボル除去・デッドコード削減を行い、
  **圧縮後（3/10 MiB）と圧縮前（64 MB）の双方**を抑える（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）。
  **単一 Worker を既定**とし、機能ごとの Worker 分割 + **Service Bindings**（[ADR-0008](./0008-cloudflare-platform-bindings.md)）連携は
  **真にサイズ超過する場合の任意のフォールバック**と位置づける（現行 3 MiB 上限下では多くの場合不要）。
- **CPU**: 重い処理は Cloudflare サービス（R2/Cache/エッジ圧縮: [ADR-0012](./0012-middleware-equivalents.md)）へ委譲。
  本文は素通し（[ADR-0007](./0007-streaming-readablestream.md)）。ホットパスのログ/シリアライズを抑制（[ADR-0013](./0013-observability.md)）。
- **メモリ**: 大きな本文の全量バッファを避ける。長命 isolate のメモリ挙動を計測し、必要なら状態を
  外部（KV/D1/Durable Objects）へ逃がす（isolate ローカルに溜めない: [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）。
- **計測**: サイズ・コールドスタート・p50/p99 レイテンシ・メモリ推移を CI/デプロイで継続計測し、
  回帰を検出する。

## 結果 (Consequences)

### 良い結果 (Positive)

- 制約を前提に設計するため、デプロイ不能（サイズ超過）・タイムアウトを未然に防げる。
- 機能分割 + Service Bindings で、サイズ上限を構造的に回避できる。

### 悪い結果・トレードオフ (Negative)

- 機能分割は構成（複数 Worker・bindings・デプロイ）を複雑化する。
- サイズ/CPU 最適化（`wasm-opt`、依存削減）に継続工数がかかる。

### 中立・フォローアップ (Neutral / Follow-up)

- 具体的なサイズ/レイテンシの予算（しきい値）を定め、CI ゲート化する。
- コールドスタート（reactor 初期化 + 初回 GC）の実測と、初期化の遅延化/事前ウォームの要否を検討する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 制約を一級化（依存最小・最適化・分割・計測）

- 利点: デプロイ可能性とレイテンシを担保。構造的にスケール。
- 欠点: 構成の複雑化、最適化工数。

### 単一 Worker に全部載せ、超過時に対処

- 利点: 構成が単純。
- 欠点: サイズ超過でデプロイ不能に陥りやすく、後追い対処は高コスト。

### パフォーマンス後回し

- 利点: 初期の機能開発が速い。
- 欠点: Workers では制約が厳しく、後からの是正が大規模化しがち。

## 遵守事項 (Compliance)

- [ ] バンドルサイズ（**圧縮後と圧縮前 64 MB の双方**）・コールドスタート・レイテンシを CI/デプロイで計測し、
  しきい値を設けて回帰を防ぐ。
- [ ] WAI/network/crypton 等の大きな/不可な依存を持ち込まない。
- [ ] リンク後に `wasm-opt`/strip を実施する。
- [ ] 永続状態は isolate ローカルに溜めず外部バインディングへ逃がす。

## 参考資料 (References)

- Cloudflare Workers — Limits（サイズ/CPU/メモリ）: https://developers.cloudflare.com/workers/platform/limits/
- Haskell Discourse — Blog system on Cloudflare Workers（1 MiB 超過で 5 Worker 分割・各サイズ）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- GHC User's Guide — WebAssembly backend（単一スレッド RTS）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html

## 追補 (2026-07-24): Phase A theme A7 Unit e/f — バンドルサイズ/コールドスタートの実測 harness と gate 化、実測値、startup CPU 上限の訂正

- ステータス: 承認（追補・実装済み、全ゲート EXIT 0）
- 日付: 2026-07-24
- 決定者: lihs（theme A7 実行編成に基づく実装時決定の記録。実装 = A7 Unit e/f）

本追補は「遵守事項」の未充足項目（バンドルサイズ・コールドスタート・レイテンシの CI/デプロイ計測と
しきい値ゲート）のうち、**バンドルサイズと（ゲート非対象の参考値としての）コールドスタート**を
「測る仕組み」まで具体化した A7 Unit e/f の結果を記録する（実際の GitHub Actions 配線自体は A8 の
item 13 スコープであり、本追補の対象外）。

### 決定 1: 実測 harness は実際にアップロードされる artifact を対象にする

`wrangler deploy --dry-run --outfile=<path>` は Cloudflare API に一切接触せず（`--dry-run: exiting
now.` を出力した時点で即終了、実機確認済み）、実際にアップロードされる artifact（esbuild による
bundling 後）をそのまま生成する。手元の `.wasm`/`.mjs` ファイルサイズの単純合算では wrangler 側の
bundling を反映しないため、計測はこの artifact に対して行う（`skeleton/justfile` の `measure-bundle`
recipe、実装は `examples/quickstart/scripts/measure-bundle-size.mjs`）。

### 決定 2: gzip 近似は node `zlib.gzipSync`、budget は Free プランの 3 MiB（gzip 後）/ 64 MiB（圧縮前）

raw サイズは実ファイルのバイト数そのものであり近似ではないが、gzip サイズは Cloudflare 側の実圧縮
（アルゴリズム/設定非公開）とは厳密には一致しない可能性がある近似値である。本 codebase のバンドル
構成（wasm バイナリがペイロードの大半を占める）では wrangler 自身が `wrangler deploy --dry-run` の
stdout に出す `Total Upload: ... / gzip: ...` の実測値と **0.02%（raw）/ 0.09%（gzip）以内**で一致
することを毎回の実測で確認しており、この近似は本 codebase の構成では十分実用的である（構成比が
大きく変わった場合に再確認が必要という限界は明記する）。budget はプラットフォームの「最も緩い、
擁護可能な」上限（無料枠 3 MiB gzip 後 / 両プラン共通 64 MiB 圧縮前）をデフォルトとし、超過検知
スクリプトが non-zero exit する形で gate 化した。この budget 自体をプロジェクト固有のより厳しい
値へ締め直すことは、本 Unit の遵守事項未充足のフォローアップとして残る。

### 決定 3: `wrangler check startup`（alpha）の出力を解析するラッパースクリプトを新設

`wrangler check startup --worker=<bundle> --outfile=<path.cpuprofile>` は stdout に数値サマリを一切
出さない（実測確認済み、wrangler 4.113.0 — `.cpuprofile` ファイルと「このマシンのローカル CPU で
計測した」旨の注記のみ）。`measure-cold-start.mjs`（新設）が Chrome DevTools 形式の `.cpuprofile`
JSON（`nodes`/`startTime`/`endTime`/`samples`/`timeDeltas`、全てマイクロ秒単位）を解析し、wall
clock（`endTime - startTime`）と sampled 合計（`Σ timeDeltas`）の 2 指標を出す。`wrangler check
startup` は Cloudflare 自身の `workers-sdk`（`packages/wrangler/src/check/commands.ts`）で
`status: "alpha"` と明記されたコマンドであり、将来の API/出力形式変更に備える。

### ★訂正: 「startup CPU 予算 400ms」はプラットフォームのハード上限ではない — 実際のハード上限は 1 秒

A7 の実装過程で参照されていた「予算 400ms」という数値は、この codebase 自身が過去の非公式 probe
（先行する ad hoc 計測）に対して自主的に設けた、より厳しい内輪の目標値であり、**Cloudflare 自身が
文書化しているプラットフォームのハード上限ではない**。Context7（`/websites/developers_cloudflare_workers`、
"Worker startup time"、2026-07-24 時点で現行確認済み）によれば、実際のハード上限は
**「Worker は global scope を 1 秒（1000ms）以内に parse・実行しなければならない」** であり、
超過すると `10021`（"Script startup exceeded CPU time limit"）で **アップロード自体が拒否される**。
本 ADR の「決定要因」「決定」節が言及する「短い CPU 予算」の文脈で「400ms」という数値を参照する場合は、
以後この 1 秒という正しいプラットフォーム値と併記し、400ms は「この codebase が自主的に採用している、
より厳しい内輪の目標」として区別して扱う（プラットフォームのハード制約として引用しない）。

### 実測値（baseline → final、A7 Unit e/f）

詳細な実測レポートは `skeleton/docs/performance-baseline.md`（本追補と対をなす、実装リポジトリ側の
一次記録）に集約している。要点のみ転記する:

| Metric | Baseline（Unit b/c/d 着手前、`d073925`） | Final（Unit b/c/d 完了後、`6180e33`） | Budget | 結果 |
|---|---|---|---|---|
| Raw（圧縮前） | 7,407,336 B（7.064 MiB、64 MiB の 11.04%） | 7,733,661 B（7.375 MiB、64 MiB の 11.52%） | 64 MiB | PASS（+4.41%） |
| Gzip（近似） | 1,319,227 B（1.258 MiB、3 MiB の 41.94%） | 1,366,428 B（1.303 MiB、3 MiB の 43.44%） | 3 MiB（無料枠） | PASS（+3.58%、残余 1.696 MiB = budget の 56.56%） |
| Cold start（local、6 回計測の wall clock 範囲） | 14.6–24.9 ms | 15.358–16.251 ms | ゲート対象外（参考値） | 回帰なし（final の範囲は baseline の範囲に完全包含） |
| Large body 1 MB / 10 MB / 100 MB（T2 正しさ） | 全 PASS（11 ms / 29 ms / 316 ms） | 変更なし（Unit b/c/d は `/echo-stream` の zero-copy pass-through 経路に触れていない、最終 `test-integration` 実行で再確認済み） | — | PASS |

新規 FFI ブリッジ（server push 用 `readableStreamFromProducer`/`producerDrivenReadableStreamViaFFI`、
client 側の応答受信・アップロード両方向での同ブリッジ再利用）と Cache モジュール一式の追加によるサイズ
増分は raw で 4.41%、gzip で 3.58% と軽微であり、budget に対する余裕（raw 11.52%、gzip 43.44%）は
引き続き大きい。コールドスタートは局所的なノイズの範囲内で回帰なし。

### ★注記: large body 100MB の T2 通過は edge 上の安全性の証明ではない

`large-body-echo-stream.spec.ts` の 100MB ケースが vitest サンドボックス（Node.js、実 edge isolate の
128MB 制約より緩いメモリ制約下）で PASS することは、**バイト数・SHA-256 ハッシュが正しく往復する
という「正しさ」の証明であって、実 edge isolate 上での安全性（CPU/メモリ制限に抵触しないこと）の
証明ではない**。この非対称性（T2 pass ≠ edge で安全）は checklist 項目 9（CPU/OOM 実測、A6 Unit 12）
と同じ扱いであり、実 edge 上での 100MB ケースの挙動は Phase A theme A7 close の RE 一括バッチで別途
観測する（本追補のスコープ外）。

### 遵守事項への影響（本文 override）

- 「バンドルサイズ（圧縮後と圧縮前 64 MB の双方）・コールドスタート・レイテンシを CI/デプロイで計測し、
  しきい値を設けて回帰を防ぐ」の**うち、バンドルサイズは実際に gate 化された**（`just measure-bundle`
  + `measure-bundle-size.mjs` の budget 超過時 non-zero exit、意図的な低 budget 値での自己検査 RED→GREEN
  実演済み）。コールドスタートは alpha コマンド依存のため参考値どまりで gate 化していない（しきい値
  ゲートは今回のスコープ外）。CI（GitHub Actions）への実配線自体は A8 item 13 のスコープであり、
  本追補では「測る仕組み」までを充足したことのみを記録する。

### 参考資料（追補分）

- Cloudflare Docs — Worker limits（バンドルサイズ）: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Docs — Worker startup time（1 秒のハード上限）: Context7 `/websites/developers_cloudflare_workers`
  "Worker startup time"（2026-07-24 確認）
- Cloudflare `workers-sdk` — `wrangler check startup`（alpha コマンド）: `packages/wrangler/src/check/commands.ts`
- 実装・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/skeleton/docs/performance-baseline.md`
  （baseline・final 両方の一次記録）、`_phase_a/a7-plan.md`「### Unit e」節・「実行状態」節、
  `API-LEDGER.md`「A7 Unit d」「A7 Unit c」節

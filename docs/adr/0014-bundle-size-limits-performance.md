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

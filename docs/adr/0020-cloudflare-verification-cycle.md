# ADR-0020: Cloudflare 上での動作を確証する3重ループ検証サイクルを定める

- ステータス: 承認
- 日付: 2026-06-27
- 決定者: lihs
- 関連: [ADR-0002](./0002-wasi-reactor-workerd-integration.md), [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md), [ADR-0013](./0013-observability.md), [ADR-0014](./0014-bundle-size-limits-performance.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md), [ADR-0016](./0016-non-fetch-entrypoints.md), [ADR-0017](./0017-testing-strategy.md), [ADR-0019](./0019-monorepo-package-layout.md)

## 背景と課題 (Context)

[ADR-0017](./0017-testing-strategy.md) は「何を試すか」（vanilla GHC 単体・wasm 統合・servant 互換性）の
**テスト分類**を、[ADR-0015](./0015-build-deploy-ci-pipeline.md) はビルド・デプロイ・CI の**パイプライン**を、
[ADR-0014](./0014-bundle-size-limits-performance.md) は**サイズ/CPU/メモリの計測**を定めた。しかし、これらを
束ねて「**このライブラリが実際に Cloudflare 上で動く**ことを反復的に確証するループ（検証サイクル）」は
未定義である。

現状、動作確認の `smoke` は宣言止まりで実行されていない。[AGENTS.md](../../AGENTS.md) は
「Smoke (v1: 宣言のみ)」とし、`wiring_manifest.yml` の `smoke:` フィールドは未実行、
`.github/workflows/pr-gate.yml` の `integration_smoke` ジョブは宣言された smoke を grep するだけである。
一方で同じ [AGENTS.md](../../AGENTS.md) の Done 条件は「要求挙動が **real public entrypoint から到達可能**で、
**観測可能挙動を実行 assert** した」ことを求めており、宣言止まりの smoke ではこの門を機械的に満たせない。

加えて、Cloudflare 上での動作には**ローカルエミュレーション（Miniflare/workerd）では再現されない**側面がある。
実エッジのコールドスタート CPU 予算（[ADR-0014](./0014-bundle-size-limits-performance.md)）、実 Cloudflare
Access の JWT 発行（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）、実 Cron Trigger の発火・実 Queues 配信
（[ADR-0016](./0016-non-fetch-entrypoints.md)）、実バンドルのアップロード受理、実 tail/Workers Logs への到達
（[ADR-0013](./0013-observability.md)）がそれである。reactor の `_initialize` 一回・ウォーム isolate
（[ADR-0002](./0002-wasi-reactor-workerd-integration.md)/[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）の
ような実行時挙動も、最終的には実環境で確証されるべきである。

したがって、テスト分類（[ADR-0017](./0017-testing-strategy.md)）の上に乗る運用上の検証サイクルを定義し、
宣言止まりの smoke を実行可能な観測 assert へ昇格させ、ローカルで確証できるものと実エッジでしか確証できない
ものを切り分ける必要がある。

## 決定要因 (Decision Drivers)

- 「Cloudflare 上で動く」を**観測可能挙動の実行 assert**として確証でき、[AGENTS.md](../../AGENTS.md) の Done 門を機械的に満たすこと
- Miniflare/workerd が再現しない実エッジ固有挙動（実受理・実 HW 性能・実 Access・実 Cron/Queues・実 Logs）を確証できること
- 決定論的で速い per-PR ゲートと、運用重い実エッジ検証を**別 cadence**に分離できること
- [ADR-0014](./0014-bundle-size-limits-performance.md) の「しきい値ゲート化 + 回帰検出」を機構として実装すること
- 秘匿情報・課金アカウントを持たない repo / fork でも CI が緑になること（[ADR-0015](./0015-build-deploy-ci-pipeline.md) の opt-in 慣行）
- 既存資産（[ADR-0019](./0019-monorepo-package-layout.md) の `examples/quickstart`・`justfile`、pr-gate の `integration_smoke`）を再利用すること

## 検討した選択肢 (Considered Options)

1. **3重ネストループ（dev inner / CI ローカルエミュレーション / release 実エッジ）+ 宣言 smoke の実行化**
2. ローカルエミュレーションのみ（実 Cloudflare には出さず Miniflare/workerd で完結）
3. 実エッジを preview versions の軽量運用に倒す（実 Cron/Queues の発火確認を諦める）

## 決定 (Decision)

採用する選択肢: **選択肢 1（3重ネストループ + 宣言 smoke の実行化）**

検証サイクルを 3 つのネストしたフィードバックループとして構成する。本 ADR は [ADR-0017](./0017-testing-strategy.md)
（テスト分類）を置き換えず、その上に乗る運用サイクルとして定義する。

### ループ構成

- **dev inner ループ**（ローカル・高速反復）: [ADR-0019](./0019-monorepo-package-layout.md) の `justfile`
  （`just dev` = `wrangler dev` + WASM 再ビルド watch）。開発者が編集ごとに最短で挙動を確認する。
- **CI ループ**（per-PR・ローカルエミュレーション・決定論的・秘匿不要）: `typecheck → 単体/互換([ADR-0017](./0017-testing-strategy.md))
  → wasm build([ADR-0015](./0015-build-deploy-ci-pipeline.md)) → bundle + サイズゲート([ADR-0014](./0014-bundle-size-limits-performance.md))
  → workerd/Miniflare smoke（real entrypoint で観測 assert）`。
- **release ループ**（実エッジ・別 cadence・秘匿 opt-in）: `examples/quickstart` を実 Cloudflare へ deploy し、
  実エッジで smoke + 観測（tail/Logs）+ 計測を行う。

### 検証 assertion 集合と「ローカル充足 / 実エッジ必須」の振り分け

「動く」の観測可能 assertion を次のとおり定め、Miniflare/workerd が忠実に再現できるもの（1–8）は CI/inner で
ローカル充足、再現しない実エッジ固有（9–13）のみ release ループに残す。

| # | assertion（観測可能挙動） | 典拠 | ループ |
| --- | --- | --- | --- |
| 1 | reactor `_initialize` が isolate 毎に一度・`main` no-op・複数 fetch でウォーム共有 | [0002](./0002-wasi-reactor-workerd-integration.md)/[0004](./0004-fetch-entrypoint-request-lifecycle.md) | ローカル |
| 2 | real entrypoint `fetch` が `/`→200・ルーティング到達 | [0006](./0006-servant-execution-engine.md) | ローカル |
| 3 | env binding round-trip（KV put/get・D1 等が往復） | [0008](./0008-cloudflare-platform-bindings.md) | ローカル |
| 4 | ReadableStream 本文の素通し | [0007](./0007-streaming-readablestream.md) | ローカル |
| 5 | Access 検証ロジック（fixture JWKS+署名トークンで valid 受理 / invalid 拒否 → Identity 注入） | [0009](./0009-auth-zero-trust-subtlecrypto.md) | ローカル |
| 6 | queue consume・scheduled dispatch のロジック | [0016](./0016-non-fetch-entrypoints.md) | ローカル |
| 7 | バンドルが size 上限内（圧縮後 / 圧縮前 64 MB） | [0014](./0014-bundle-size-limits-performance.md) | ローカル |
| 8 | WouldBlock 境界が結線パスで発火しない | [0004](./0004-fetch-entrypoint-request-lifecycle.md) | ローカル |
| 9 | 実バンドルが実エッジに受理される（`wrangler deploy` 成功） | [0014](./0014-bundle-size-limits-performance.md)/[0015](./0015-build-deploy-ci-pipeline.md) | 実エッジ |
| 10 | 実コールドスタート / CPU 予算 / p50・p99 レイテンシ | [0014](./0014-bundle-size-limits-performance.md) | 実エッジ |
| 11 | 実 Cloudflare Access（実 team JWKS・実エッジが `Cf-Access-Jwt-Assertion` 注入） | [0009](./0009-auth-zero-trust-subtlecrypto.md) | 実エッジ |
| 12 | 実 Cron Trigger 発火 / 実 Queues 配信 | [0016](./0016-non-fetch-entrypoints.md) | 実エッジ |
| 13 | ログが実 tail/Workers Logs へ到達 | [0013](./0013-observability.md) | 実エッジ |

観測は「成功表示」で代替せず、**read-back まで**確認する（env round-trip は delete 後の不在確認、Access は
Identity 注入の assert）。

### 実エッジ環境モデルと cadence

実 Cloudflare Access アプリと Cron Trigger は CI 実行ごとに生成/破棄できないため、**専用の事前プロビジョン
検証環境**を採る。検証用 staging Worker・Access アプリ・Service Token・KV/D1 namespace・Cron 設定を一度だけ
事前作成し、各 release は `examples/quickstart` のコードを再 deploy して実エッジ smoke を回す。run 間の状態
bleed は **run-id で namespace したキー + 自己クリーンアップ smoke**（write→read→delete）で抑え、同時実行衝突は
CI concurrency group で直列化する。

cadence は二段とする。**nightly**（scheduled CI）は計測・回帰検出系（assertion 9・10・13）を回し、
[ADR-0014](./0014-bundle-size-limits-performance.md) の「deploy で継続計測・回帰検出」を満たす。**pre-release**
（tag / release ブランチ）は実エッジ全集合（実 Access 11・実 Cron/Queues 12 を含む）を回す。

release ループは [ADR-0015](./0015-build-deploy-ci-pipeline.md) の opt-in 慣行に倣い、**repo variable
（`ENABLE_EDGE_VERIFY=true`）+ Cloudflare API token / Access secret が揃う repo だけで起動**し、無い repo / fork
では skip する（CI は緑のまま）。

### ゲートモデルと証跡

- **CI ループ = PR の required merge gate**。`pr-gate.yml` の `integration_smoke` を**宣言 grep から実行へ反転**し
  （`nix develop -c just test-integration` = workerd/Miniflare smoke の実走）、`wiring_manifest.yml` の `smoke:`
  フィールドを「CI ループが実行する実コマンド」の意味に昇格させる。
- **release ループ = release（tag/release）の required gate + nightly 回帰**。per-PR の required gate には課さない
  （毎 PR で実エッジ deploy は不可）。実エッジ受理失敗（assertion 9）はデプロイ不能を意味するため pre-release で
  blocking とする。
- 両ループとも `.agent-evidence/verify/{ci,edge}-report.json` に **各 assertion → pass/fail・到達した real
  entrypoint・計測値**を出力し、[AGENTS.md](../../AGENTS.md) の証跡規約（`.agent-evidence/`）と Stop hook
  `scripts/agent-evidence-gate.sh` を満たす。結線パス（[ADR-0019](./0019-monorepo-package-layout.md) の wiring
  point: API 型 → HasServer → foreign export）を触る変更は、CI ループ smoke が real entrypoint で緑かつ証跡を出して
  初めて Done とする。

### 計測ゲート

- **サイズ**（CI ループ・artifact からローカル計測）: **圧縮前 64 MB を超えたら blocking**（デプロイ不能の絶対
  上限）。圧縮後は **10 MiB を budget・3 MiB を warn** とする。
- **コールドスタート・p50/p99 レイテンシ・メモリ単調増加**（release ループ・実エッジ実測）: ハンドラ依存で可搬な
  絶対目標を置けないため**回帰相対**で判定する。baseline は単一の真実源として **`ci/perf-budget.yml`**（既存
  `ci/allowlist.yml` と同じ governance ファイル慣行）に commit し、サイクルがこれと比較する。**baseline 更新は
  golden 更新と同型の reviewable な PR 差分**とする。nightly が実測してトレンドを残し、pre-release が budget で
  ゲートする。

### 検証ハーネス

主ハーネスは **TS/vitest** とし、[ADR-0019](./0019-monorepo-package-layout.md) の
`examples/quickstart/test/integration/` を再利用して **target でパラメタ化**する（CI=ローカル
workerd/Miniflare/`@cloudflare/vitest-pool-workers`、release=実エッジ URL）。deploy は `wrangler`、assertion 13 の
観測は `wrangler tail` を用いる。`servant-cloudflare-workers-client`
（[ADR-0011](./0011-outbound-http-fetch-backend.md)）を用いた dogfooding smoke は任意の追加確証（client 自身が
未検証のため主経路にはしない）とする。

## 結果 (Consequences)

### 良い結果 (Positive)

- 宣言止まりだった smoke が実行可能な観測 assert に昇格し、[AGENTS.md](../../AGENTS.md) の Done 門（real entrypoint
  到達 + 観測 assert）を機械的に満たせる。
- Miniflare が再現しない実エッジ固有挙動（実受理・実 HW 性能・実 Access・実 Cron/Queues・実 Logs）を実環境で確証できる。
- 決定論的で速い CI ゲートと運用重い実エッジ検証が cadence で分離され、per-PR の速度を保てる。
- [ADR-0014](./0014-bundle-size-limits-performance.md) の計測・しきい値・回帰検出が `ci/perf-budget.yml` を真実源とする
  機構として実装される。
- secret 無し repo / fork でも CI（required）が緑になり、貢献の敷居を上げない。

### 悪い結果・トレードオフ (Negative)

- 実エッジ検証環境（staging Worker・Access アプリ・Service Token・KV/D1・Cron）の事前プロビジョンと秘匿管理の
  運用コストが生じる。
- 専用環境が永続するため、run 間の状態 bleed を namespace + 自己クリーンアップで抑える設計責任が残る。
- 実 Access・実 Cron を含む pre-release 検証は遅く、release の所要時間を伸ばす。
- 回帰相対の性能ゲートは baseline の保守（環境ノイズによる false positive のチューニング）を要する。

### 中立・フォローアップ (Neutral / Follow-up)

- `ci/perf-budget.yml` の初期 baseline 値（コールドスタート・レイテンシ）は最初の実エッジ計測で確定する。
- 性能回帰判定の許容幅（baseline 比 N%）と、環境ノイズに対するリトライ/中央値化の方針を定める。
- **Durable Objects のハイバネーション / WebSocket（[ADR-0010](./0010-websockets-durable-objects.md)）の実エッジ
  e2e は本サイクルの Non-goal とし**（[ADR-0017](./0017-testing-strategy.md) も最小限 Miniflare シナリオに留めて
  いる）、別 ADR で扱う。
- `wrangler.toml` の binding/Cron/Queues consumer 宣言と Haskell 側 export の整合検証
  （[ADR-0008](./0008-cloudflare-platform-bindings.md)/[ADR-0016](./0016-non-fetch-entrypoints.md)）を本サイクルの
  deploy 前チェックに組み込むかを検討する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 3重ネストループ + 宣言 smoke の実行化

- 利点: 「サイクル」の語義（フィードバックループ群）に忠実。実エッジ release ループで「Cloudflare で動く」を確証でき、
  inner/CI は既存足場を再利用。宣言止まりの smoke と Done 門を機構として結びつける。
- 欠点: 実エッジ環境の事前プロビジョン・秘匿管理・状態 bleed 対策の運用コスト。

### ローカルエミュレーションのみ

- 利点: secret/課金アカウント不要、決定論的で速い。既存 0015+0017 を束ねるだけで済む。
- 欠点: Miniflare は実コールドスタート CPU 予算・実 Access JWT・実 Cron 発火・実バンドル受理を再現せず、「Cloudflare
  上で動く」の最終確証にならない。決定要因の中核を満たせない。

### 実エッジを preview versions の軽量運用に倒す

- 利点: 永続 deploy 不要で軽量。route/env/Access の実エッジ確認には足りる。
- 欠点: preview URL では**実 Cron Trigger 発火・実 Queues 配信（assertion 12）が試せない**。非 fetch entrypoint
  （[ADR-0016](./0016-non-fetch-entrypoints.md)）の実エッジ確証が欠落する。

## 遵守事項 (Compliance)

- [ ] dev inner（`just dev`）/ CI（per-PR・ローカルエミュレーション）/ release（実エッジ）の3ループを構成し、
      release ループの deploy 対象を `examples/quickstart` とする。
- [ ] CI ループの smoke を実行可能化する（`pr-gate.yml` の `integration_smoke` を grep から `just test-integration`
      実走へ反転し、`wiring_manifest.yml` の `smoke:` を実行コマンドとして扱う）。CI ループは PR の required merge gate とする。
- [ ] assertion 1–8 を CI/inner（ローカル）、9–13 を release（実エッジ）で確証し、観測は read-back まで行う。
- [ ] release ループは専用事前プロビジョン環境へ deploy し、run-id namespace + 自己クリーンアップでデータ分離、
      CI concurrency group で直列化する。cadence は nightly（計測）/ pre-release（実エッジ全集合）とする。
- [ ] release ループは repo variable + Cloudflare secret の opt-in でゲートし、未設定 repo / fork では skip する。
- [ ] 両ループは `.agent-evidence/verify/{ci,edge}-report.json` に assertion 結果・到達 entrypoint・計測値を出力する。
- [ ] サイズは圧縮前 64 MB を blocking、圧縮後 10 MiB を budget / 3 MiB を warn とする。コールドスタート・レイテンシ・
      メモリは `ci/perf-budget.yml` の baseline 比で回帰判定し、baseline 更新は reviewable な PR 差分とする。
- [ ] 検証ハーネスは TS/vitest を主とし、`examples/quickstart/test/integration/` を local/edge の target で
      パラメタ化して再利用する。

## 参考資料 (References)

- Cloudflare Workers — Limits（サイズ/CPU/メモリ/サブリクエスト）: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers — Testing（Miniflare / `@cloudflare/vitest-pool-workers`）: https://developers.cloudflare.com/workers/testing/
- Cloudflare Workers — `wrangler` versions & deployments: https://developers.cloudflare.com/workers/configuration/versions-and-deployments/
- Cloudflare Workers — Tail / Workers Logs: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Cloudflare Access — Validating JWTs / Service Tokens: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
- [調査メモ](../research/feasibility-servant-on-cloudflare-workers.md)

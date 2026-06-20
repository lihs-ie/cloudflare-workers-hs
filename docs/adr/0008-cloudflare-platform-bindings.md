# ADR-0008: Cloudflare プラットフォームバインディングを env 経由でハンドラ文脈に供給する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)

## 背景と課題 (Context)

実運用の Worker は `fetch(request, env, ctx)` の `env` 経由で各種リソースに触れる。代表的なものは
**KV**（キーバリュー）、**R2**（オブジェクトストレージ）、**D1**（SQLite 系 DB）、
**Durable Objects**（強整合な常駐オブジェクト）、**Queues**、**Service Bindings**（Worker 間 RPC）、
**Secrets/Vars**（機密・環境変数）、**Cache API** である。Servant ハンドラからこれらを型付きで安全に
使えるようにすることが、実運用に「不自由なく」到達する条件となる。

本プロジェクトは自前実装方針のため、これらのバインディングは [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) の
JSFFI バインディング層の上に**自前で実装**する。

## 決定要因 (Decision Drivers)

- `env` の各リソースを型付きで宣言・取得できること（誤った binding 名・型の検出）
- Servant ハンドラ文脈へ `env`/`ctx` を注入できること（[ADR-0006](./0006-servant-execution-engine.md) の解釈系と統合）
- 非同期 API（KV/R2/D1 はいずれも Promise）を async JSFFI で扱えること
- 段階的に対応バインディングを増やせる拡張性

## 検討した選択肢 (Considered Options)

1. **型付き `Env` を宣言し、`env`/`ctx` を Servant ハンドラ文脈へ注入する自前バインディング群**
2. ハンドラ内で都度 `env` を動的に触る（共通の型付き層を設けない）
3. 外部バインディングライブラリ（`ghc-wasm-earthly` の D1/R2/KV 等）へ依存する

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- 利用するバインディングを型で宣言する `Env` 表現を用意し、`env` から名前で取り出すアクセサを
  JSFFI で実装する。各リソース（KV/R2/D1/Durable Objects/Queues/Service Bindings/Secrets/Cache）に
  対応する newtype と型付き操作（KV: get/put/delete/list、R2: get/put/head/delete、
  D1: prepare/bind/all/run、Queues: send/sendBatch、Service Bindings: fetch/RPC）を提供する。
- `env`/`ctx` は fetch エントリ（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）から
  サーバ解釈系（[ADR-0006](./0006-servant-execution-engine.md)）のハンドラ文脈へ注入する。
  Servant の文脈（`Context`/`ReaderT` 的注入、または専用組み合わせ子）として表現する。
- 非同期操作はすべて async JSFFI（Promise/`await`）で表現する。
- 実装は段階的とし、**MVP は KV / R2 / D1 / Secrets / Service Bindings** を優先、
  Durable Objects（[ADR-0010](./0010-websockets-durable-objects.md) と連携）・Queues・Cache は後続で拡充する。
- **設定・シークレットの供給と起動時検証**: 機密は `wrangler secret`、非機密は Vars で供給し、環境（dev/staging/prod）は `wrangler` の environments で分離、ローカルは `.dev.vars` を用いる。必須設定（Access の `aud`・チームドメイン・JWKS URL（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）、ログレベル（[ADR-0013](./0013-observability.md)）等）は **型付きの「必須設定」面**にまとめ、**isolate 初期化時に検証し、欠落/不正なら fail-fast** する。

## 結果 (Consequences)

### 良い結果 (Positive)

- ハンドラから Cloudflare リソースを型安全に使え、実運用に必要なデータ層が揃う。
- `env` 注入が解釈系と統合され、Servant の宣言的記述の中で binding を扱える。

### 悪い結果・トレードオフ (Negative)

- 各バインディング API を逐次実装・追従する工数（Cloudflare 側 API 変更への保守）。
- バインディングを増やすほどバンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）が増える。使用分のみを含める工夫が要る。

### 中立・フォローアップ (Neutral / Follow-up)

- `wrangler` の binding 宣言（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）と Haskell 側の型宣言の
  整合を検証する仕組み（命名・存在チェック）を検討する。
- Durable Objects のクラス定義（JS 側 export）と Haskell 側の対応は [ADR-0010](./0010-websockets-durable-objects.md) で扱う。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 型付き `Env` + 文脈注入（自前）

- 利点: 型安全・解釈系統合・段階拡張。方針と整合。
- 欠点: 実装/追従工数、サイズ増。

### 都度動的アクセス

- 利点: 前準備が最小。
- 欠点: 型安全性が低く、binding 名/型の誤りを実行時まで検出できない。

### 外部バインディング依存

- 利点: 初期工数が小さい。
- 欠点: 自前実装方針に反する。作者が R2/Cache 周りを「推奨しない」とする等、脆さがある。

## 遵守事項 (Compliance)

- [ ] `env` アクセスは型付きバインディング層を経由し、ハンドラに生 JSFFI を散在させない。
- [ ] 非同期リソース操作は async JSFFI として型に反映する。
- [ ] 外部の Cloudflare バインディングライブラリへ依存しない。
- [ ] 必須設定は起動時に検証し、欠落/不正時は明確に失敗させる（実行時まで遅延させない）。

## 参考資料 (References)

- Haskell Discourse — Blog system on Cloudflare Workers（D1/R2/KV/Service Bindings の自前バインディング）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- GHC User's Guide — WebAssembly backend（JSFFI/async）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- konn/ghc-wasm-earthly（設計参照のみ）: https://github.com/konn/ghc-wasm-earthly

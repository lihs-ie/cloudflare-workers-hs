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

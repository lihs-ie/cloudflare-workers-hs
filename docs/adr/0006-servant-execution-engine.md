# ADR-0006: Servant 互換の型駆動ルーティング/サーバ解釈系を自前実装する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0005](./0005-http-layer-no-wai.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0011](./0011-outbound-http-fetch-backend.md), [調査メモ](../research/feasibility-servant-on-cloudflare-workers.md)

## 背景と課題 (Context)

本ライブラリの目的は「Servant を Cloudflare Workers で不自由なく使えるようにする」ことである。
Servant は型レベル API DSL（`:>`, `:<|>`, `Capture`, `QueryParam`, `ReqBody`, `Verb`/`Get`/`Post` 等）と、
それを解釈してサーバを構築する `HasServer`（`servant-server`）から成る。

ここで `servant-server` は推移的に `network` へ依存し `wasm32-wasi` でビルドできない（検証済み）。
したがって `servant-server` をそのまま使うことはできない。

**プロジェクト方針は「フォークせず全て自前で実装する」である。** 本 ADR ではこれを次のように解釈する。

> 「フォーク禁止・自前実装」とは、**`servant-server` をフォークも依存もせず、サーバ解釈系
> （ルーティング・引数抽出・コンテンツネゴシエーション・エラー応答）を本ライブラリで自前実装する**
> ことを指す。ただし **Servant の型レベル DSL（`servant` コアの組み合わせ子）は本ライブラリの存在
> 目的そのもの**であるため、上流の `servant` コアを**再利用**する（これはフォークではなく利用である）。

## 決定要因 (Decision Drivers)

- 「Servant を使えるようにする」という目的（既存の Servant API 型をそのまま書けること）
- フォーク禁止・自前実装・外部 Workers-Servant ライブラリ非依存の方針
- `wasm32-wasi` でビルド可能な依存のみで構成できること
- WAI を介さない直接 `Request`/`Response`（[ADR-0005](./0005-http-layer-no-wai.md)）と統合できること

## 検討した選択肢 (Considered Options)

1. **`servant` コア DSL を再利用し、サーバ解釈系（`HasServer` 相当）を自前実装する**
2. `servant-server` をフォークして `wasm32-wasi` 対応版を作る（先行例 `servant-cloudflare-workers`）
3. 外部の Workers 向け Servant 実装（`servant-cloudflare-workers` / `Steward`）に依存する
4. Servant とは別の独自 API DSL を一から作る（組み合わせ子も含めて全再実装）

## 決定 (Decision)

採用する選択肢: **選択肢 1**

`servant` コア（純 Haskell・型レベル DSL、`wasm32-wasi` でビルド可能）を再利用し、その API 型を解釈して
Workers の直接 `Request`/`Response`（[ADR-0005](./0005-http-layer-no-wai.md)）に対してルーティングする
**独自のサーバ解釈系を自前実装**する。具体的には `HasServer` に相当する型クラスを定義し、
`Capture`/`QueryParam`/`ReqBody`/`Header`/`Verb` 等の各組み合わせ子に対する解釈を、
独自 HTTP 型の上で実装する。`ServerError` 相当のエラー表現から Workers `Response` への変換も自前で定義する。
**エラーモデル**は次を決める: (a) ルート不一致は **404**、メソッド不一致は **405**、`Accept` 不適合は **406**、
`Content-Type` 不適合は **415**、本文デコード/検証失敗は **400**（`servant-server` の状態コード意味論に準拠）。
(b) エラー本文の既定は JSON エンベロープとし、コンテンツネゴシエーションに応じて plain text へフォールバックする。
(c) この対応を `servant-server` 互換性テスト（[ADR-0017](./0017-testing-strategy.md)）の検証対象とする。

Workers 固有の要素（`env` バインディングの注入: [ADR-0008](./0008-cloudflare-platform-bindings.md)、
`ReadableStream` ストリーミング: [ADR-0007](./0007-streaming-readablestream.md)）は、独自の組み合わせ子
／コンテキストとして本解釈系に追加する。`servant-cloudflare-workers` や `Steward` は **設計参照のみ**とし、
依存にもフォーク元にもしない。

## 結果 (Consequences)

### 良い結果 (Positive)

- 既存の Servant API 型をそのまま記述でき、目的（Servant を使う）を満たす。
- `servant-openapi3` 等、`servant` コア型を入力とする周辺ツールと型を共有できる余地が残る。
- サーバ側を完全に制御でき、Workers の制約（短い CPU 予算・ストリーム素通し）に最適化できる。
- 外部 Workers-Servant 依存が無く、保守範囲とバンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）を自分で制御できる。

### 悪い結果・トレードオフ (Negative)

- `HasServer` 相当を自前実装する設計・テスト工数が大きい（組み合わせ子網羅・型レベルプログラミング）。
- `servant-server` の挙動（コンテンツネゴシエーション、エラー整形など）と微妙に異なるリスク。互換性テストが要る。
- `servant` コアが将来 `network` 等に推移依存しないことを継続確認する必要がある。

### 中立・フォローアップ (Neutral / Follow-up)

- `servant` コアの再利用可否（依存グラフが `wasm32-wasi` で完結するか）をビルドで実証する。
  万一コアが不可なら、必要最小限の組み合わせ子型を自前定義する縮退案（選択肢 4 寄り）へ移行する。
- 対応する組み合わせ子の優先順位（MVP: `Capture`/`QueryParam`/`ReqBody`/JSON `Verb`）を実装計画で定める。

> 補足: 「全て自前」を**組み合わせ子の型まで再実装する**意味に解する場合は本決定（選択肢 1）を見直し、
> 選択肢 4 へ切り替える。その場合は `servant` ツール群との型共有は失われる。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `servant` コア再利用 + 解釈系自前実装

- 利点: Servant 互換・周辺ツール共有・完全制御・依存最小。方針と目的に整合。
- 欠点: 解釈系の実装/互換テスト工数。

### `servant-server` をフォーク

- 利点: 既存実装を出発点にできる。
- 欠点: フォーク禁止方針に反する。`network` 依存の除去という重い保守を継続的に負う。

### 外部 Workers-Servant 実装へ依存

- 利点: 初期工数が最小。
- 欠点: 自前実装方針に反する。`servant-cloudflare-workers` は Hackage 未公開で git 依存になり、
  作者自身も後継 `Steward` へ移行中。保守を他者に委ねることになる。

### 独自 DSL を全再実装

- 利点: 完全に自由。方針「全て自前」に最も忠実。
- 欠点: 「Servant を使えるようにする」という目的から外れ、`servant` エコシステムとの互換を失う。

## 遵守事項 (Compliance)

- [ ] `servant-server`・`wai`・`warp`・`network` へ依存しない。
- [ ] 外部の Workers 向け Servant 実装（`servant-cloudflare-workers`/`Steward` 等）へ依存しない。
- [ ] サーバ解釈系（`HasServer` 相当）と `ServerError` 相当のエラー応答を自前で提供する。
- [ ] `servant` コア DSL を入力に取れること（標準的な API 型がコンパイルできること）をテストで担保する。

## 参考資料 (References)

- Haskell Discourse — Serverless Haskell（servant-server の network 依存・自作型駆動ルータ）: https://discourse.haskell.org/t/serverless-haskell-with-ghc-wasm-jsffi-cloudflare-workers/9784
- Haskell Discourse — Blog system on Cloudflare Workers（`servant-cloudflare-workers` フォークの背景）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- konn/ghc-wasm-earthly（`Steward` は設計参照のみ）: https://github.com/konn/ghc-wasm-earthly

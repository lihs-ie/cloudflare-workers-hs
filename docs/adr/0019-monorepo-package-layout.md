# ADR-0019: ライブラリのモノレポ構成と4パッケージ分割を定める

- ステータス: 承認
- 日付: 2026-06-21
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0005](./0005-http-layer-no-wai.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md), [ADR-0011](./0011-outbound-http-fetch-backend.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md), [ADR-0016](./0016-non-fetch-entrypoints.md), [ADR-0017](./0017-testing-strategy.md), [ADR-0018](./0018-versioning-release-distribution.md)

## 背景と課題 (Context)

ADR-0001〜0018 はコンパイルツールチェーン・HTTP 層・サーバ解釈系・認証・配布方針など個別の技術判断を確定したが、
**それらをディスク上にどう配置し、何個の cabal パッケージに分割し、利用者がどう依存するか**は未決だった。
本リポジトリはこれまで ADR・ガバナンス資産のみで、ライブラリ本体のソースは未配置である。
`AGENTS.md` には単一パッケージ前提（root 直下に `src/` と `app/Main.hs`）の暫定スケッチが置かれているが、これは
確定構成ではない。

構成を決めるうえで固有の制約と要求がある。

- 公開 API 表面が4系統に分かれる。[ADR-0006](./0006-servant-execution-engine.md) の自前 `HasServer` 相当の
  サーバ解釈系、[ADR-0011](./0011-outbound-http-fetch-backend.md) の送信クライアント解釈系、
  [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)/[ADR-0008](./0008-cloudflare-platform-bindings.md) の
  バインディング層、[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md) の Cloudflare Access 認証である。
- [ADR-0018](./0018-versioning-release-distribution.md) は Hackage 公開を第一級とし、型レベル API の破壊的変更を
  Package Versioning Policy で管理すると定めた。下流が `servant` / `servant-auth` のように**必要な層だけを個別に
  導入・固定**できることが望ましい。
- [ADR-0017](./0017-testing-strategy.md) は「stock GHC 単体」「実 wasm 統合」「servant 互換性」の三層テストを要求し、
  [ADR-0001](./0001-ghc-native-wasm-backend.md) のコードを vanilla GHC でも型検査・実行可能に保つ必要がある。
- [ADR-0015](./0015-build-deploy-ci-pipeline.md) は WASM ビルドが時間・リソースを要する一級制約であると明記し、
  ライブラリは利用者の `foreign export javascript "fetch"`（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）を
  所有できない。したがって全結線を通した実例は本体の外に要る。

これらを満たす物理レイアウト・パッケージ分割・モジュール名前空間・テスト/ビルド構成を一つの構造方針として確定する。

## 決定要因 (Decision Drivers)

- 下流が `servant`/`servant-auth` のように**必要な層だけを個別に依存・固定**でき、依存解決が破綻しないこと
- [ADR-0018](./0018-versioning-release-distribution.md) の Hackage-first・PVP・対応マトリクス運用と自己一貫すること
- [ADR-0006](./0006-servant-execution-engine.md) の「フォーク禁止・全て自前実装」「konn の Cloudflare バインディング非依存」を尊重すること
- Haskell エコシステム（特に隣接する `servant`）の確立した慣行に沿い、貢献者が前提なく構造を理解できること
- [ADR-0017](./0017-testing-strategy.md) の三層テストと vanilla GHC 互換シムを構造として無理なく収容できること
- [ADR-0015](./0015-build-deploy-ci-pipeline.md) の重い WASM ビルドを踏まえ、維持する完全ビルドを最小化できること
- 型レベル API の破壊的変更（[ADR-0018](./0018-versioning-release-distribution.md)）を構造で受け、安定面と機構面を分離できること

## 検討した選択肢 (Considered Options)

1. **独立公開する複数 cabal パッケージのモノレポ（root 直下フラット配置）**
2. 単一 cabal パッケージ（全モジュールを 1 パッケージに同梱）
3. 複数パッケージだが `packages/` サブディレクトリに集約する
4. ベンダリング専用モノレポ（外部利用者を想定しない）——これは [ADR-0018](./0018-versioning-release-distribution.md) が既に却下済み

## 決定 (Decision)

採用する選択肢: **選択肢 1（独立公開する複数パッケージのモノレポ・フラット配置）**

[ADR-0018](./0018-versioning-release-distribution.md) が却下した「モノレポ専用（外部非公開）」とは異なり、本決定の
モノレポは**開発上の単一リポジトリでありながら、各パッケージを独立に Hackage 公開する**ものである。下流の個別導入性は
「パッケージ分割 + Hackage-first + クリーンな依存辺 + PVP 境界」によって担保され、リポジトリ内のディレクトリ配置とは
直交する（`cabal.project` も配置フォルダ名も sdist に含まれず Hackage からは見えない）。

### パッケージ分割（4 本）と依存グラフ

| パッケージ | 役割 / 所有する ADR | 依存 |
| --- | --- | --- |
| `cloudflare-workers`（基盤・leaf） | JSFFI バインディング([0003](./0003-jsffi-cloudflare-bindings-layer.md))、直接 HTTP Request/Response([0005](./0005-http-layer-no-wai.md))、fetch reactor ライフサイクル([0004](./0004-fetch-entrypoint-request-lifecycle.md))、env プラットフォームバインディング([0008](./0008-cloudflare-platform-bindings.md))、ReadableStream([0007](./0007-streaming-readablestream.md))、非 fetch entrypoint([0016](./0016-non-fetch-entrypoints.md))、可観測性([0013](./0013-observability.md))、送信 fetch プリミティブ([0011](./0011-outbound-http-fetch-backend.md) の生 backend)、生 SubtleCrypto/getRandomValues バインディング([0009](./0009-auth-zero-trust-subtlecrypto.md) の暗号プリミティブ) | `base` + ghc-wasm JSFFI のみ。**servant 非依存** |
| `servant-cloudflare-workers`（server） | `HasServer` 相当の解釈系・エラーモデル・コンテンツネゴシエーション([0006](./0006-servant-execution-engine.md))、ミドルウェア相当([0012](./0012-middleware-equivalents.md))、`serve` 相当のエントリ補助 | 基盤 + `servant` コア |
| `servant-cloudflare-workers-client`（client） | fetch backend クライアント解釈系([0011](./0011-outbound-http-fetch-backend.md)) | 基盤 + `servant-client-core` |
| `servant-cloudflare-workers-access`（auth） | Access の全責務（`Identity`、JWKS 取得+キャッシュ、RS256 検証、Service Token (M2M)、`CloudflareAccess` 組み合わせ子 + Context 注入、副系アプリ JWT。[0009](./0009-auth-zero-trust-subtlecrypto.md)） | 基盤 + server |

認証（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）は2面に割る。**生 SubtleCrypto/getRandomValues のバインディング**は
Web Crypto という汎用ランタイム API であり認証専用ではないため**基盤に置く**。**Access 検証ロジックと servant 組み合わせ子**は
auth パッケージに集約し、組み合わせ子が server の Context/AuthProtect 機構に依存するため auth は基盤と server の双方に依存する
（依存グラフ上は最上位）。

### 物理レイアウト（フラット）

各パッケージは root 直下に自身のディレクトリを持つ。これは隣接する `servant`（`servant/` `servant-server/`
`servant-client/` …）や `yesod` `persistent` `wai` の Haskell web ライブラリ慣行に一致する。`packages/`/`libs/` の
サブディレクトリ集約は JS（npm workspaces）/ Rust（`crates/`）寄りの習慣で、Haskell web ライブラリの規範ではないため採らない。
「公開アーティファクト」と「メタ/example/ツールチェーン」の区別は、ディレクトリ階層ではなく `cabal.project` の packages
リストと命名規約（`*cloudflare-workers*` = 公開、`examples/` = 非公開）で担保する。

### モジュール名前空間

基盤 = `Cloudflare.Workers.*`、server = `Servant.Cloudflare.Workers.*`、client = `Servant.Cloudflare.Workers.Client.*`、
auth = `Servant.Cloudflare.Workers.Access.*`。**全パッケージで複数形 `Workers` に統一**する。略語はプロジェクト命名規約
（[CLAUDE.md](../../CLAUDE.md) / [AGENTS.md](../../AGENTS.md)）に従い `HTTP` のように大文字単位とする（`AGENTS.md` 暫定
スケッチの `Http*` は誤りとして本決定で `HTTP` に正す）。基盤に `Network.` を冠さないのは、基盤の責務がネットワークに
留まらず reactor ライフサイクル・可観測性・entrypoint・env を含むためである。

### 公開/内部の2層 API

> **置換 (→ ADR-0028):** この節の `*.Internal.*` を `exposed-modules` とする決定は、
> [ADR-0028](./0028-hide-internal-modules-from-consumers.md) により置き換えられた。Internal module は
> `other-modules` とし、必要な能力は型付き公開 façade または最小 extension API で提供する。

型レベル機構を多用するパッケージは、安定 façade モジュールと `*.Internal.*` モジュールに分ける。`*.Internal.*` は
`exposed-modules` として見せるが Haddock で「PVP 保証なし」と明記する。これは `servant`/`servant-server` の
`Servant.Server.Internal.*` 慣行に倣い、[ADR-0018](./0018-versioning-release-distribution.md) の型レベル破壊的変更運用を
構造で受けるためである。façade が変わらない限り機構のリファクタは patch/minor に収まる。最も volatile な生
`foreign import javascript` は `Internal/FFI/*` に隔離する。

### example ワーカー（単一正典・統合 fixture 兼用）

ライブラリは利用者の foreign export を所有できないため、全結線（Servant API 型 → 自前 `HasServer` 解釈 →
`foreign export javascript "fetch"`）を通した実例を `examples/quickstart/` に1つ置く。これは `cabal.project` に載る
**非公開 executable パッケージ**であり、foreign export を持つ唯一の場所である。[ADR-0015](./0015-build-deploy-ci-pipeline.md) の
重い WASM ビルドを踏まえ、維持する完全ビルドを1本に絞るため、この example を [ADR-0017](./0017-testing-strategy.md) の
tier2（実 `.wasm` reactor を workerd/Miniflare/Node post-link ハーネスで回す統合）の fixture として兼用する。
[ADR-0015](./0015-build-deploy-ci-pipeline.md) が要求する複数 Worker 分割の構成例は、当面フル example 化せず
`docs/` と `wrangler` スニペットで示す。

### JS ランタイム（v0 は repo 内グルー）

GHC-wasm の foreign export を Workers モジュールに変えるブートストラップ JS は、v0 では example の `index.mjs` を
**正典テンプレート**として提供し、下流はこれをコピーして用いる。公開 npm パッケージ化はバージョン管理すべき
Haskell↔JS ABI（export 名・ディスパッチ規約）が実装後に確定するまで時期尚早であり、将来 ABI 安定後に**新規 ADR で
ゲート**して判断する。top-level `js/` は将来の昇格先として名前のみ予約し、v0 では作成しない。post-link.mjs / WASI shim は
vendor せず nix-pin した GHC libdir から呼ぶ。

### テスト構成

`tasty`（`tasty-hunit` / `tasty-quickcheck` / `tasty-golden`）を用いる。各パッケージに `unit` スイート（tier1: stock GHC
で純ロジック）を置き、server パッケージに `compat` スイートを別 stanza で持つ（tier3: [ADR-0017](./0017-testing-strategy.md)）。
互換性の oracle は checked-in golden（400/404/405/406/415）と手書き spec モデルとし、[ADR-0006](./0006-servant-execution-engine.md)/
[ADR-0017](./0017-testing-strategy.md) の方針どおり `servant-server` には**テスト時も依存しない**（stock GHC 上でビルド可能でも
oracle に使わない）。tier2 は `examples/quickstart/test/integration/*.ts` に置く。

### 二重ビルド（stock GHC ↔ wasm32-wasi）

各パッケージの `src/` は単一ツリーとする。純コア（Router・コンテンツネゴシエーション・引数抽出）は純 Haskell 型の上で
動かし、stock GHC で native 実行する（tier1/tier3 が直接対象にする）。JSFFI エッジは `ghc-wasm-compat` を
`!arch(wasm32)` 限定の stock-GHC 専用依存として用い、同一ソースを wasm では実バインド・stock では型シムとして型検査する。
並行 `hs-source-dirs` は採らない（[ADR-0017](./0017-testing-strategy.md) が指摘するシム/実装ドリフト＝「単体緑/統合赤」の
温床を避けるため）。`ghc-wasm-compat` は GHC-wasm の型シムであって Cloudflare バインディングではないため、
[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)/[ADR-0006](./0006-servant-execution-engine.md) の非依存規則の対象外であり、
[ADR-0017](./0017-testing-strategy.md) 自身がこのシムを明示的に許容している。

### ツールチェーン / 開発オーケストレーション

root に `flake.nix` + `flake.lock`（[ADR-0015](./0015-build-deploy-ci-pipeline.md) の ghc-wasm-meta を主とする
ツールチェーン供給）、`cabal.project`（4 パッケージ + example を列挙、再現性は `index-state:` pin と `flake.lock` で取り
`cabal.project.freeze` は置かない）、`justfile`（`build-worker` / `dev` / `test-unit` / `test-integration` の開発タスク）、
`fourmolu.yaml`（整形）を置く。既存の `.hlint.yaml` と `scripts/verify-*.sh`（agent-policy の CI ゲート）は据え置き、
開発タスク（`justfile`）とは責務を分離する。

### ADR-0018 との関係

[ADR-0018](./0018-versioning-release-distribution.md) は「本ライブラリ」を単数で記述し配布・PVP・対応マトリクスを定めたが、
本決定により対象が4パッケージになる。0018 の方針は**各パッケージに独立に適用**し、「本ライブラリ」は「本パッケージ
ファミリ」と読み替える。これは 0018 の supersede ではなく適用範囲の明確化であり、0018 自体の決定（Hackage-first・PVP・
対応マトリクス）は変更しない。

## 結果 (Consequences)

### 良い結果 (Positive)

- 下流が `servant`/`servant-auth` のように必要な層（server だけ / client だけ / auth 追加）を個別に依存・固定でき、
  [ADR-0018](./0018-versioning-release-distribution.md) の Hackage-first と自己一貫する。
- 隣接 `servant` と同じフラット慣行・`Servant.Cloudflare.Workers.*` 名前空間により、貢献者が前提なく構造を理解できる。
- 安定 façade と `*.Internal.*` の分離により、型レベル機構のリファクタが破壊的変更に化けにくく、PVP 運用が現実的になる。
- 単一正典 example が tier2 統合 fixture を兼ねるため、維持する完全 WASM ビルドが1本で済み、「example が緑＝結線が生きている」を
  一手で担保できる。
- 単一 `src/` ツリー + `ghc-wasm-compat` により、並行ツリーのシム/実装ドリフトを構造的に排除する。

### 悪い結果・トレードオフ (Negative)

- 4 パッケージそれぞれに `.cabal`/`LICENSE`/`README`/`CHANGELOG.md` を自己完結配置し、相互に PVP バージョン境界を維持する
  運用コストが生じる。
- auth が基盤と server の双方に依存するため、副系アプリ JWT だけを使う利用者も server を引く。
- `ghc-wasm-compat` という konn 製ライブラリへの（stock-GHC 限定の型シムとしての）依存が1つ増え、「全て自前」の精神とは
  緊張する（規則の文言には抵触しない）。
- JS ブートストラップを下流がコピーするため、npm ヘルパ提供までは reactor/WouldBlock の機微を各自が抱える。

### 中立・フォローアップ (Neutral / Follow-up)

- `wiring_manifest.yml` の `src/**/Api*.hs`・`app/Main.hs`・`src/**/Binding/**.hs`・`src/**/Entrypoint/**.hs` 系ルールを、
  多パッケージ + `examples/quickstart/` スコープへ再スコープする（`binding-type-matches-wrangler` は
  `cloudflare-workers/src/**/Env/**.hs` ↔ `examples/quickstart/wrangler.toml`）。
- `AGENTS.md` の「予定モジュール構成」節（単一パッケージ前提・`Http*`）と ADR 本数表記、`CLAUDE.md` の ADR 範囲表記、
  `docs/adr/README.md` 索引を本決定に合わせて更新する。
- JS ランタイムの npm 公開へ昇格する場合は、Haskell↔JS ABI を定義する新規 ADR を起こす。
- [ADR-0015](./0015-build-deploy-ci-pipeline.md) の複数 Worker 分割の `docs` + `wrangler` スニペットを別途用意する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 独立公開する複数パッケージのモノレポ（フラット）

- 利点: 下流の個別導入が成立し、隣接 `servant` の慣行に一致。層ごとに独立 versioning でき、責務境界が明快。
- 欠点: 公開・PVP 境界・CHANGELOG をパッケージ数だけ維持する運用コスト。

### 単一 cabal パッケージ

- 利点: 公開・semver・対応マトリクス運用が1系統で済み pin が単純。初期は密結合な進化に追従しやすい。
- 欠点: server だけ / client だけ欲しい利用者も全体を引き、型レベル機構の変更が全部同じ major に乗る。`servant`/`servant-auth`
  流の個別導入が成立しない。

### `packages/` サブディレクトリ集約

- 利点: コードとガバナンス資産が視覚的に分離し、「`packages/*` = 公開1個」の不変条件が可視化される。
- 欠点: Haskell web ライブラリの規範（フラット）から外れ、隣接 `servant` と不揃いになる。個別導入性はフラットと同じで
  利得は美観に留まる。

### ベンダリング専用モノレポ（外部非公開）

- 利点: 外部互換性の制約から解放され内部で自由に変更できる。
- 欠点: 「公開ライブラリを提供する」という目的に反し、[ADR-0018](./0018-versioning-release-distribution.md) が既に却下済み。

## 遵守事項 (Compliance)

- [ ] ライブラリは `cloudflare-workers` / `servant-cloudflare-workers` / `servant-cloudflare-workers-client` /
      `servant-cloudflare-workers-access` の4パッケージとして root 直下フラットに配置し、`cabal.project` で束ねる。
- [ ] 各パッケージは `.cabal` / `src/` / `LICENSE` / `README` / `CHANGELOG.md` を自己完結で持ち、兄弟パッケージの `src/` を
      跨いで参照しない（`cabal sdist` が単独で通る）。README に「`wasm32-wasi` 専用・stock GHC 実行不可」を明記する
      （[ADR-0018](./0018-versioning-release-distribution.md)）。
- [ ] パッケージ間依存は本 ADR の依存グラフに従い、相互に PVP バージョン境界を張る（`client` は server/auth を引かない）。
- [ ] モジュール名前空間は基盤 `Cloudflare.Workers.*` / server `Servant.Cloudflare.Workers.*` / client `…​.Client.*` /
      auth `…​.Access.*`、複数形 `Workers` 統一、コード識別子の略語は許可略語（`URL`/`URI`/`UUID`/`ULID`/`HTTP` 等）のみ。
- [ ] 型レベル機構は `*.Internal.*` に置き、生 `foreign import javascript` は `Internal/FFI/*` に隔離する。
      [ADR-0028](./0028-hide-internal-modules-from-consumers.md) に従い、Internal module は expose しない。
- [ ] foreign export を持つのは `examples/quickstart/` のみとし、これを [ADR-0017](./0017-testing-strategy.md) tier2 の統合
      fixture として用いる。`packages` 相当の公開パッケージに `app/Main.hs` 的 foreign export を置かない。
- [ ] 各パッケージ `src/` は単一ツリーとし、stock GHC 型検査は `ghc-wasm-compat` を `!arch(wasm32)` 限定依存で用いる。
      並行 `hs-source-dirs` を作らない。
- [ ] 互換性テストは golden + spec モデルを oracle とし、`servant-server`・`wai`・`warp`・`network` に（テストを含め）
      依存しない（[ADR-0006](./0006-servant-execution-engine.md)/[ADR-0017](./0017-testing-strategy.md)）。
- [ ] root に `flake.nix`+`flake.lock` / `cabal.project`（`index-state` pin・freeze なし）/ `justfile` / `fourmolu.yaml` を置き、
      post-link.mjs / WASI shim は vendor せず nix-pin libdir から呼ぶ。
- [ ] `wiring_manifest.yml` を本構成（多パッケージ + `examples/quickstart/`）に再スコープする。

## 参考資料 (References)

- haskell-servant/servant（`servant` / `servant-server` / `servant-client` のフラットなモノレポ慣行・`Servant.Server.Internal.*`）: https://github.com/haskell-servant/servant
- yesodweb/yesod（`yesod-core` / `yesod-auth` / `yesod-auth-oauth` … のフラット配置）: https://github.com/yesodweb/yesod
- Haskell Package Versioning Policy（PVP）: https://pvp.haskell.org/
- GHC User's Guide — WebAssembly backend（JSFFI / reactor / post-linker）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- konn/ghc-wasm-earthly（`ghc-wasm-compat` で vanilla GHC でも型検査可能・設計参照のみ）: https://github.com/konn/ghc-wasm-earthly
- [調査メモ](../research/feasibility-servant-on-cloudflare-workers.md)

## 追補 (2026-07-22): 二重ビルド方式と FFI 隔離範囲の確定

- ステータス: 承認（追補）
- 日付: 2026-07-22
- 決定者: lihs

### 決定 1: stock GHC 型検査は `ghc-wasm-compat` シムを用いない

本文「二重ビルド（stock GHC ↔ wasm32-wasi）」節が前提としていた `ghc-wasm-compat` を `!arch(wasm32)`
限定依存として用いる方式を、次の方式に置き換える。

- (a) **cabal の `if os(wasi)` 条件分岐**: FFI シェルモジュールは `wasi` 側のみ `exposed-modules`
  とし、`ghc-experimental` への依存も `wasi` 限定にする。
- (b) **ソース内 CPP** `#if defined(wasm32_HOST_ARCH)`: opaque handle 型を、wasm ビルドでは
  newtype でラップした `JSVal`、host（stock GHC）ビルドでは uninhabited な型／STUB 構築子として
  定義する。

**本 ADR の核（単一 `src` ツリー・並行 `hs-source-dirs` を採らない）は変更しない。** 上記 (a)(b) は
いずれも単一ツリー内で完結する分岐であり、シムに依存せず stock GHC 側の型検査を成立させる。

### 理由

- `ghc-wasm-compat` は course canonical で **NOT_USED** と宣言済みであり、spike の実機検証で
  実際の JSFFI 呼び出しに不要と判明した。
- CPP 方式は spike A1-A3 で実証済み: pure core は host 上の tier1 テストで検証可能、FFI シェルは
  wasm 専用ビルドとしてのみコンパイルされる。

### 決定 2: `Internal/FFI/*` 隔離の適用範囲

本文「公開/内部の2層 API」節の「最も volatile な生 `foreign import javascript` は `Internal/FFI/*`
に隔離する」の適用範囲を確定する。

- 対象は**公開ライブラリ 4 パッケージ**（`cloudflare-workers` / `servant-cloudflare-workers` /
  `servant-cloudflare-workers-client` / `servant-cloudflare-workers-access`）であり、
  `examples/quickstart` はこの隔離規則の対象外とする。`examples/quickstart` は probe／配線
  fixture として、`foreign import`/`foreign export` を持つ正当な site である
  （本文「example ワーカー」節の tier2 統合 fixture との役割に合致）。
- 機械検査 `scripts/verify-ffi-boundary.sh` の allowlist は
  `*/Internal/FFI/*.hs` + `examples/quickstart/app/Main.hs` とする。

### 決定 3（関連）: 移植コードの attribution

移植コード（`servant-server` 由来。[ADR-0006](./0006-servant-execution-engine.md) 追補参照）は、
モジュールヘッダに BSD-3 attribution を保持する。

### 遵守事項への影響（本文 override）

本文「遵守事項 (Compliance)」の以下の項目は、本追補により内容を変更する（本文自体は書き換えない）。

- 「各パッケージ `src/` は単一ツリーとし、stock GHC 型検査は `ghc-wasm-compat` を `!arch(wasm32)`
  限定依存で用いる。並行 `hs-source-dirs` を作らない。」
  → **追補により「単一ツリー・並行 `hs-source-dirs` 不採用」は維持**しつつ、型検査手段を
  cabal `if os(wasi)` 条件 + ソース内 CPP `#if defined(wasm32_HOST_ARCH)` に変更する。
  `ghc-wasm-compat` への依存は追加しない。
- 「型レベル機構は `*.Internal.*`（exposed・Haddock で PVP 無保証明記）に置き、生
  `foreign import javascript` は `Internal/FFI/*` に隔離する。」
  → **追補により適用範囲を公開ライブラリ 4 パッケージに限定**すると明記。`examples/quickstart` は
  対象外（`scripts/verify-ffi-boundary.sh` の allowlist に `examples/quickstart/app/Main.hs` を含む）。

### 参考資料（追補分）

- [ADR-0006](./0006-servant-execution-engine.md) 追補（移植方式・BSD-3 attribution）
- [ADR-0017](./0017-testing-strategy.md) 追補（vanilla GHC ビルドの互換手段変更）

## 追補 (2026-07-24): spike 移行裁定 — 供給元を自前 shim に精緻化

- ステータス: 承認（追補・plan 確定分）
- 日付: 2026-07-24
- 決定者: lihs

**本追補は plan 確定時点の起票である。移行（theme A6b）close 時に整合確認を行い、乖離があれば本追補への
追記または `_phase_b/divergence-notes.md` で記録する。**

### 背景

Phase A spike は、上の 2026-07-22 追補「決定 1」が導入した CPP `#if defined(wasm32_HOST_ARCH)` を
opaque handle 型が絡むモジュールごとに個別展開し、host 側は STUB constructor（uninhabited 型／
`error "unimplemented"` 相当）で埋める形で theme A1〜A6 を実装してきた。**単一 `src/` ツリー・並行
`hs-source-dirs` 不採用という ADR-0019 の核自体は維持されている**が、STUB constructor が
`Internal/FFI/*` の枠を越えて public/production モジュールにまで広がり、本文が本来 host 型シムに
託していた「シム/実装ドリフトの排除」という目的（07-22 追補時点の意図は host 側の型検査手段を
narrow に保つことだった）から外れつつあった（既知逸脱として記録済み）。lihs 裁定（2026-07-24 grill、
production-extension-grill.md E-Q13）により、本 ADR 準拠（host 型シムによる型検査）へ移行することが
確定した。

### 決定 1（本文の精緻化）: host 型シムの供給元を自前 vendored module に確定

本文「二重ビルド」節が元々規定していた構造——単一 `src/` ツリー + host 型シムを `!arch(wasm32)` 限定
依存として用いる——という骨格自体は正しく、2026-07-22 追補がこれを opaque handle 型ごとの CPP 分岐
（+ host STUB constructor の個別定義）へ全面置換したのは行き過ぎだった。本追補は供給元のみを差し替えて
骨格を復元する。

- 供給元は `ghc-wasm-compat`（konn 製）では**ない**。2026-07-22 追補「決定 1」の「`ghc-wasm-compat` は
  用いない」という結論自体は維持する。
- 供給元は**自前 vendored module**とする。根拠は実測: spike 全体（theme A1〜A6）の `GHC.Wasm.Prim`
  由来 import 箇所を grep 実測したところ全 37 箇所すべてが `import GHC.Wasm.Prim (JSVal)` であり、
  必要な表面積は opaque（コンストラクタなし）な `JSVal` の実質 1 型のみだった。`JSException` /
  `JSString` / `freeJSVal` / `mkWeakJSVal` / `toJSString` / `fromJSString` 等の他シンボルは wasm
  専用ゲート（`#if defined(wasm32_HOST_ARCH)` の wasm 側分岐）内かコメント上にしか現れず、host 側
  シムとして提供する必要がない。したがって供給すべきシムは `data JSVal` の ~10 行の module 1 個で
  足りる。
- 外部個人メンテのライブラリへの GHC 追従リスクを新たに抱えず、「全て自前」方針と完全に整合する。
- **配置は未確定（A6b で実装者が確定）**: 候補は (a) `!arch(wasm32)` 限定の cabal internal
  sublibrary として各公開パッケージに個別提供、または (b) 4 パッケージ共有の最小 package。本追補は
  候補の提示にとどめ、cabal 構成（sublibrary か共有パッケージか、提供モジュール名を wasm 側
  `GHC.Wasm.Prim` と同名にして stock GHC ビルド時のみ差し替えるか等）は A6b で確定する。

### 決定 2: 条件コンパイル（CPP）の許容範囲を `Internal/FFI/*` に限定

2026-07-22 追補「決定 1(b)」のソース内 CPP `#if defined(wasm32_HOST_ARCH)` は、host 側 opaque handle
型定義という限定用途を意図していたが、spike ではより広い範囲（public/production モジュールを含む）に
浸食した。本追補は許容範囲を **`Internal/FFI/*` モジュール限定**に確定する。対象は `foreign import
javascript` 宣言が stock GHC で受理されない場合のエッジケースのみであり、public/production モジュール
では STUB constructor・`error "unimplemented"` の類を完全にゼロとすることを要求水準とする。

stock GHC が `foreign import javascript` 宣言そのものをどこまで受理するか（受理されない場合にのみ CPP
が真に必要になる）は、theme A6b の Step 0 probe で実証確定する。

### 決定 3: 移行タイミング = A6 close 直後・A7 着手前（独立 theme A6b）

移行は既存 theme（A6）の close 直後、次 theme（A7）着手前に独立 theme A6b として実施する。A7 は Phase A
中で FFI 追加が最多の theme であるため、A7 着手後に移行すると手戻りが最大化する。A6 close 直後に済ませ
ておくことで、A7 以降の新規 FFI コードは最初から本追補の構造（自前 shim + `Internal/FFI/*` 限定 CPP）
で書ける。

既存コース `cloudflare-workers-hs-build`（84 章、Phase A 以前の CPP パターンをすでに教材化済み）との
構造乖離は `divergence-notes` の major entry として記録し、Phase B のコース更新時に「足場構造（CPP
パターン）→ production 構造（自前 shim + 限定 CPP）への進化」という narrative として吸収する。既存章の
逐次書き換えは本追補の対象外とする。

### 実装状況（plan 確定時点の記録）

plan 確定時点の起票である。自前 shim module（配置未確定・`data JSVal` を供給）の実在、`Internal/FFI/*`
限定への CPP 縮退、public/production モジュールの STUB/CPP ゼロ化のいずれも、本追補時点では未着手・
未確認である。theme A6b close 時に整合確認する。

### 遵守事項への影響（本文・2026-07-22 追補への override）

本文「遵守事項 (Compliance)」および 2026-07-22 追補「遵守事項への影響」の該当項目は、本追補により内容
を変更する（いずれの記述自体も書き換えない）。

- 「型検査手段を cabal `if os(wasi)` 条件 + ソース内 CPP `#if defined(wasm32_HOST_ARCH)` に変更する。
  `ghc-wasm-compat` への依存は追加しない。」
  → **追補により、host 側の型検査は自前 vendored module（`!arch(wasm32)` 限定、opaque `data JSVal`
  のみを持つ ~10 行。internal sublibrary か共有 package かの cabal 配置は A6b で確定）が供給する。
  `ghc-wasm-compat` を用いないという結論は維持する。ソース内 CPP は `Internal/FFI/*` 限定
  （`foreign import javascript` が stock GHC で受理されないエッジケースのみ、範囲は A6b Step 0
  probe で確定）に縮退し、public/production モジュールでの STUB constructor・
  `error "unimplemented"` はゼロを要求水準とする。**

### 参考資料（追補分）

- production-extension-grill.md E-Q13（裁定の正文）:
  `~/workspace/pschool/courses/cloudflare-workers-hs-build/_plan/production-extension-grill.md`
- 本 ADR 2026-07-22 追補（`ghc-wasm-compat` 不使用の初回確定、CPP 方式の導入）
- [ADR-0006](./0006-servant-execution-engine.md)（「フォーク禁止・全て自前実装」方針）

## 追補 (2026-07-24): theme A6b close — 実装確定（配置・供給元・CPP 許容範囲の最終着地）

- ステータス: 承認（追補・実装確定）
- 日付: 2026-07-24
- 決定者: lihs

上の 2026-07-24 追補（「spike 移行裁定」、以下「前追補」）は plan 確定時点の起票であり、供給元は
「自前 vendored module（`data JSVal` の ~10 行）」、CPP 許容範囲は「`Internal/FFI/*` 限定」、配置は
「未確定（sublibrary か共有 package か）」として実装（theme A6b）に委ねていた。本追補は theme A6b
close（`~/.pschool/spikes/cloudflare-workers-hs-build/skeleton`、Unit 0〜E）が実際に何を実装し、
前追補の各未確定点がどう着地したかを確定する。

### 決定 1: 供給元は「型シムのみ」ではなく「型シム + FFI source plugin」の両方 —— 前追補の想定を上回る到達点

前追補は `data JSVal` 抽象の ~10 行シムのみを想定していたが、実装時の裁定（production-extension-grill.md
E-Q13、theme A6b 起票時）で **CPP 完全ゼロ（`Internal/FFI/*` を含む）** を目標に引き上げた。これを
`JSVal` 型シムだけで達成することはできない —— `foreign import/export javascript` 宣言そのものが
stock GHC の decl-check で拒否される（GHC-01245／`JavaScriptFFI` 拡張自体も stock GHC ターゲットでは
GHC-46537 により拒否される）ため、型を揃えるだけでは `Internal/FFI/*` モジュール自身の CPP は消せない。

実装が採用した供給元は次の 2 モジュール対（`cloudflare-workers:ghc-wasm-shim` internal sublibrary、
`if os(wasi)`/`else` で cabal レベル切替、モジュール名は両ターゲットで同一）:

- `GHC.Wasm.Prim` —— host: 本追補が予告した通りの opaque `data JSVal`（コンストラクタ非公開。ただし
  実装は前追補の想定より一段防御的で、コンストラクタは `GHC.Wasm.Prim.Host.Internal` という別モジュールに
  物理的に隔離し、`GHC.Wasm.Prim` 自身は型のみ re-export する。友モジュール機構が言語にないための設計。
  境界は `scripts/verify-host-testkit-boundary.sh` で機械強制）。wasm32-wasi: 本物 `ghc-experimental`
  の `GHC.Wasm.Prim` を `reexported-modules` で verbatim 再輸出（コピーではない）。
- `GHC.Wasm.FFI.Plugin` —— host: GHC source plugin（`parsedResultAction` で `foreign import/export
  javascript` 宣言を decl-check 前に書き換え、stock GHC の型検査を通す）。konn/ghc-wasm-earthly の
  `ghc-wasm-compat` パッケージから ~90 行をほぼそのまま移植（BSD-3-Clause、Copyright (c) 2024
  Hiromi ISHII、`vendor-shim/LICENSE.ghc-wasm-compat` に全文同梱）。wasm32-wasi: 同名の no-op
  plugin（実装は前追補と無関係にこの skeleton 独自）。

この結果、`Cloudflare.Workers.Internal.FFI.*` を含む **public/production コードの CPP は完全にゼロ**
になった（前追補「決定 2」が許容範囲としていた `Internal/FFI/*` 限定 CPP は、実装ではその許容枠自体を
使わず、より上位の到達点で完了した）。残る CPP は次の 1 系統のみで、STUB／error-stub 由来ではない
意図的な dual-real 実装（前追補の対象外）:

1. `Cloudflare.Workers.Middleware`／`Cloudflare.Workers.Observability`／
   `Servant.Cloudflare.Workers.Access.Internal.Clock` —— host・wasm 双方とも本物の実装（`getPOSIXTime`
   ／`random` vs `Date.now()`／`crypto.randomUUID()`）。

（2026-07-24 訂正、レビュー LOW-3(a)）**`servant-cloudflare-workers-client`（client FFI）の
`Internal/FFI/Fetch.hs` の `RequestBodySource` は上記「残る CPP」に数えるべきではない** —— 当該箇所
（`requestBodyToStrictByteString (RequestBodySource _) = error "unimplemented (A7 scope) -- ..."`）
に `#if`/`#else` は一切無く、両ターゲットとも無条件に同一のコードパスを通る通常の関数節である。CPP 系統
ではなく、ストリーミングリクエストボディという A7 スコープの機能境界（host 専用スタブでもない）。

### 決定 2: 配置は internal sublibrary（cabal-version 3.4 bump + `visibility: public`）—— フォールバック不要

前追補「決定 1」が未確定としていた配置は、候補 (a) と (b) の中間——**単一 internal sublibrary
（`cloudflare-workers:ghc-wasm-shim`）を `cloudflare-workers` パッケージ内に 1 つだけ新設し、
`visibility: public` で 4 パッケージ全体から共有依存させる**——という形で着地した。前追補が承認済み
フォールバックとして用意していた「解決不能なら `conformance-oracle` と同様のローカル非公開パッケージへ
昇格」は、**実際には不要だった**——`cabal-version: 3.4`（multiple-public-libraries 対応）への bump と
`visibility: public` の組み合わせが実装時点の cabal-install でそのまま解決し、フォールバックへ逸脱する
理由が一度も生じなかった。同様に `library host-testkit`（A6b Unit A'、`Cloudflare.Workers.HostTestKit`
の `phantomJSVal`）も同じ internal sublibrary + `visibility: public` の型で追加され、この配置方式が
本 skeleton の標準パターンとして確立した。

### 決定 3: attribution 範囲の最終確定 —— konn 移植は host-side FFI plugin の ~90 行のみ、A8 で自前化予定

前追補は供給元を「自前 vendored module」と定めていたが、実装は型シム部分については完全に独自実装（konn
の GADTs／unlifted 精密版ではなく、この skeleton 独自の簡略な `data JSVal` 抽象）である一方、**FFI
plugin の host-side compat 実装（`vendor-shim/compat/GHC/Wasm/FFI/Plugin.hs`）のみ**は konn 製
`ghc-wasm-compat` から ~90 行を近い形で移植しており、前追補「決定 1」の「`ghc-wasm-compat`（konn 製）は
用いない」という結論を厳密には破っている。lihs 裁定（2026-07-24）により、この 1 モジュールに限り
BSD-3-Clause attribution 付きでの移植を**リリース優先の暫定措置として承認**し、対象範囲を明確にこの
~90 行のみに限定する（型シム・wasm 側 no-op plugin は attribution 不要な自前コード）。**A8 で
この host-side plugin の AST 書換ロジックを完全に自前再実装し、konn への依存と `vendor-shim/
LICENSE.ghc-wasm-compat` を撤去することを確定事項とする**（lihs 明言、`_phase_a/a6b-plan.md`
「★A8 必達 TODO」参照）。

### 遵守事項への影響（本文・両先行追補への override）

前追補「遵守事項への影響」の該当箇所は、本追補により次の通り最終確定する。

- 「host 側の型検査は自前 vendored module（`!arch(wasm32)` 限定、opaque `data JSVal` のみを持つ
  ~10 行。internal sublibrary か共有 package かの cabal 配置は A6b で確定）が供給する。」
  → **本追補により、host 側の型検査は `cloudflare-workers:ghc-wasm-shim`（`cloudflare-workers`
  パッケージ内の internal sublibrary、`visibility: public`、`cabal-version: 3.4`）が
  `GHC.Wasm.Prim`（opaque `data JSVal`）と `GHC.Wasm.FFI.Plugin`（host-side compat: konn 移植
  ~90 行、BSD-3-Clause attribution 付き。wasm-side: no-op、自前）の両方を供給すると確定する。
  `Internal/FFI/*` 限定という CPP 許容枠は実際には使われず、public/production コードの CPP は
  dual-real（Middleware／Observability／Clock）を除き完全にゼロである（A7 スコープの client FFI
  `RequestBodySource` 機能境界は CPP ではなく両ターゲット無条件の `error` によるものであり、
  この「CPP ゼロ」の対象外 —— 2026-07-24 訂正、レビュー LOW-3(a)）。**

### 参考資料（本追補分）

- `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a6b-plan.md`（Unit 0〜E の実行記録・
  ★A8 必達 TODO）
- `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_b/divergence-notes.md`「★A6b close」
  major entry（既存コース corpus との構造乖離の記録）
- `~/.pschool/spikes/cloudflare-workers-hs-build/API-LEDGER.md`（A6b close エントリ、Unit 0/A/A'/
  B/C/D/E 全 commit の要約）
- 本 ADR 2026-07-24 追補「spike 移行裁定」（本追補が確定させる前提の起票）

## A8 追補（2026-07-24、theme A8 U-P1: konn vendor の撤去）

本 ADR が定めた「konn/ghc-wasm-compat 由来 plugin の暫定 vendor（BSD-3 attribution +
LICENSE 同梱）」は、theme A8 で **clean-room 再実装により終了**した（lihs 裁定
2026-07-24 の必達事項）。

- 再実装は spec 媒介 clean-room: konn コードを読んだ agent が挙動仕様書のみを書き、
  別 agent が仕様書 + GHC 9.12 公式 docs のみから実装（vendor コード非閲覧、
  非導出記録 = spike `_phase_a/a8-plugin-reimpl-record.md`）
- konn 固有の設計 2 点は独自方式に置換: stub 式は文字列再パースでなく **AST 直接構築**
  （`GHC.Builtin.Names` の Exact RdrName 経由、DynFlags 非依存）、エラーメッセージは
  固定文面 + 関数名のみ
- `LICENSE.ghc-wasm-compat` と cabal / コメントの konn attribution を全撤去。
  `vendor-shim/` は何も vendor しなくなったため `shim/` へ rename
- 受入 = 既存 PluginProbe group + 負方向テスト 4 件追加（計 10 ケース、
  spike commits 3772265 / 1a13023 / 5a00273）。全 gate green
- 本 ADR 本文の konn / vendor 記述は当時の決定の歴史的記録としてそのまま残す

## A8 追補（2026-07-25、theme A8: ライセンス整合 — 原則 MIT / 移植を含む 1 パッケージのみ BSD-3-Clause）

theme A8 U-P6（配布品質）が 3 点の不整合を検出した。6 パッケージの `.cabal` が一律
`license: BSD-3-Clause` を宣言している一方で repo 直下の `LICENSE` は MIT（Copyright (c) 2026
lihs）であり、さらに本文「遵守事項」が必須成果物としている per-package `LICENSE` ファイルが 1 つも
存在しなかった。lihs 裁定（2026-07-25）により **MIT に揃える。ただし `servant-cloudflare-workers`
のみ BSD-3-Clause を維持する**。

### 決定 1: ライセンスは原則 MIT

`cloudflare-workers` / `servant-cloudflare-workers-client` /
`servant-cloudflare-workers-access` / `examples/quickstart` / `conformance-oracle` は
`license: MIT`、本文は repo 直下 `LICENSE`（MIT、Copyright (c) 2026 lihs）と同一テキストを各
パッケージに配置する。repo 直下にも同じ `LICENSE` を置き、`.cabal` は `license-file: LICENSE` で
sdist に同梱する。

### 決定 2: `servant-cloudflare-workers` のみ BSD-3-Clause

このパッケージは `servant-server-0.20.3.0`（BSD-3-Clause、Copyright (c) 2014-2016 Zalora South
East Asia Pte Ltd, 2016-2018 Servant Contributors）からの移植を含む。BSD-3-Clause の条件
（著作権表示の保持・no-endorsement 条項）は移植コードに随伴し、再ライセンスで外せない。よって
`license: BSD-3-Clause` を維持し、`LICENSE` には両著作権者を並記した BSD-3-Clause 全文を置く。

移植範囲は `src/` の 7 ファイル（`ContentType.hs` / `Server.hs` / `Server/Internal.hs` /
`Server/Internal/{Delayed,DelayedIO,Router,RouteResult}.hs`）。同パッケージ `test/Spec.hs` は
`servant-server` 自身のテストスイートに対応するケースを移したもので、同一パッケージ内につき同じ
`LICENSE` が及ぶ。他パッケージに移植は無い（`servant-cloudflare-workers-client` は
`servant-client-core` の `HasClient` を依存として再利用しているだけで複製していない、
`conformance-oracle` は real `servant-server` を dev 専用依存として link しているだけ）。

### 決定 3: 移植範囲は `NOTICE` で索引化する

`servant-cloudflare-workers/NOTICE` に、移植元パッケージ・バージョン・著作権表示と、ファイル単位の
provenance 表（どのファイルが上流のどのモジュール由来か）を置く。**権威は各モジュールヘッダの
attribution（2026-07-22 追補「決定 3」）のままとし、`NOTICE` はその索引**と位置づける
（宣言の重複を避けるため、宣言の詳細はモジュール側に残す）。`NOTICE` は `.cabal` の
`extra-doc-files` に加えて sdist に同梱する。

### 決定 4: 「なぜ 1 つだけ違うのか」を README に書く

repo 直下 README と 5 パッケージ README の `## License` 節に、MIT が原則で
`servant-cloudflare-workers` のみ BSD-3-Clause である理由（移植コードを含むため）を記す。読者が
`.cabal` の diff を見る前に理由へ到達できることを要件とする。

### 遵守事項への影響（本文 override）

本文「遵守事項 (Compliance)」の以下の項目は、本追補により内容を具体化する（本文自体は書き換えない）。

- 「各パッケージは `.cabal` / `src/` / `LICENSE` / `README` / `CHANGELOG.md` を自己完結で持ち…」
  → **`LICENSE` の中身を本追補で確定する**。`servant-cloudflare-workers` は BSD-3-Clause（+
  `NOTICE`）、それ以外の全パッケージは MIT。`.cabal` は `license-file: LICENSE` を必ず持ち、
  `cabal sdist` 後の tarball に `LICENSE`（`servant-cloudflare-workers` は `NOTICE` も）が
  含まれることを配布時の確認事項とする。
- 新規に他パッケージへ BSD-3-Clause（あるいは MIT より条件の強い）コードを移植する場合、**MIT の
  ままにはできない**。移植を避けるか、そのパッケージを移植元ライセンスへ移し本追補を更新する。

### 検証

- `just build` / `just test-unit` / `just lint`: 全て EXIT 0
- `cabal check`: 6 パッケージ全て "No errors or warnings"（U-P6 の 6/6 clean を維持）
- `cabal sdist all --project-file=cabal.project`: 6 tarball 全てに `LICENSE` 同梱、
  `servant-cloudflare-workers` には `NOTICE` も同梱

### 参考資料（本追補分）

- `servant-cloudflare-workers/NOTICE`（移植ファイル索引）
- 本 ADR 2026-07-22 追補「決定 3（関連）: 移植コードの attribution」（モジュールヘッダ
  attribution 保持の起票）
- [ADR-0006](./0006-servant-execution-engine.md) 追補（移植方式）
- [ADR-0018](./0018-versioning-release-distribution.md)（配布ポリシー、U-P6 の sdist 検証）

# ADR-0028: Internal モジュールを利用者から隠す

- ステータス: 承認
- 日付: 2026-09-13
- 決定者: lihs
- 関連: [ADR-0019](./0019-monorepo-package-layout.md), [ADR-0027](./0027-define-consumer-library-boundary.md)

## 背景と課題 (Context)

4つの公開パッケージは、実装詳細を `*.Internal.*` に分離していた一方、それらを Cabal の
`exposed-modules` に列挙していた。そのため利用者は、生の `JSVal` 変換、JSFFI、Servant の
ルータ内部型などへ直接依存できた。公開 façade で表現できない利用例も Internal import によって
成立しており、ライブラリが提供する契約と実装上の都合の境界が曖昧になっていた。

単に「PVP 保証外」と説明するだけでは、コンパイラは依存を防げない。公開 API の不足が Internal
利用で隠されると、利用者向け API の設計漏れも検出できない。

## 決定要因 (Decision Drivers)

- 利用者が依存できる範囲を Cabal の module visibility で強制できること
- 生の `JSVal`、envelope、値変換、JSFFI を所有パッケージ内に閉じ込めること
- 標準的な Servant 利用に instance 登録用の Internal import を要求しないこと
- 独自 combinator と outbound fetch、stream reader、Web Crypto に必要な型付き拡張点を提供すること
- 同じパッケージ内の必要な white-box test は維持できること

## 検討した選択肢 (Considered Options)

1. `*.Internal.*` を `other-modules` に移し、必要な型付き公開 API を追加する
2. exposed のまま「利用禁止」「PVP 保証外」と文書だけで規定する
3. Internal API を公開 sublibrary に分ける

## 決定 (Decision)

採用する選択肢: **選択肢 1**

次の4パッケージにあるすべての `*.Internal.*` を、library stanza の `exposed-modules` から
`other-modules` へ移す。

- `cloudflare-workers`
- `servant-cloudflare-workers`
- `servant-cloudflare-workers-client`
- `servant-cloudflare-workers-access`

利用者、兄弟パッケージ、example は Internal module を import しない。別の公開 sublibrary による
逃げ道も作らない。同一パッケージの white-box test が実装詳細を検査する必要がある場合は、その
テスト component 内に限って対象 source を home module としてコンパイルする。

不足していた正規の境界として、次を公開する。

- outbound HTTP の型付き fetch API
- runtime 表現を隠した stream reader API
- runtime 表現を隠した Web Crypto API
- 独自 Servant combinator 実装用の最小 `Server.Extension` API

標準 `HasWorkerServer` instance は公開 `Servant.Cloudflare.Workers.Server` の import だけで
利用可能にし、`import ...Server.Internal ()` を要求しない。`Server.Extension` は必要な抽象型と
構築操作だけを公開し、router constructor、実行関数、route result は公開しない。

## 結果 (Consequences)

### 良い結果 (Positive)

- 公開契約と実装詳細の境界をコンパイラが強制する。
- Internal import で隠れていた公開 API の不足が明示される。
- FFI の例外・Promise・値変換を所有パッケージ内で一元管理できる。
- example が利用者と同じ公開 surface の実証になる。

### 悪い結果・トレードオフ (Negative)

- 既存の Internal 依存テストは、公開契約テストへの変更または同一パッケージ test component への
  移動が必要になる。
- 新しい platform capability を追加するとき、FFI と同時に型付き公開 API の設計が必要になる。
- `Server.Extension` の公開範囲は拡張性と内部実装の自由度を両立するよう慎重に維持する必要がある。

### 中立・フォローアップ (Neutral / Follow-up)

- 本ライブラリは未リリースのため、従来の Internal import に対する互換層や version bump は設けない。
- 利用者向け Skill の責務定義は別の成果物であり、Internal の import 不可能化そのものは記載対象にしない。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `other-modules` と型付き公開 API

- 利点: 境界を機械的に強制でき、必要な能力は安定した名前と型で利用できる。
- 欠点: 既存コードとテストの移行が必要。

### 文書だけで利用禁止

- 利点: 変更量が少なく、内部調査目的の import は容易。
- 欠点: 誤用を防げず、Internal が事実上の公開 API になる。

### 公開 Internal sublibrary

- 利点: 通常の公開 API と分離しながら外部利用を継続できる。
- 欠点: 外部依存可能という本質が変わらず、実装詳細の互換性責務も残る。

## 遵守事項 (Compliance)

- [x] 4パッケージの公開 library stanzaは、名前に `Internal` segmentを持つ moduleを exposeしない。
- [x] 外部 consumer probeで、各パッケージの代表的な Internal importが「hidden module」として失敗する。
- [x] 同じ probeで公開 façadeの import成功を先に確認し、依存解決失敗による偽陽性を防ぐ。
- [x] 兄弟パッケージと example の production code は Internal module を import しない。
- [x] 標準 Servant API は instance 登録用の Internal import なしでコンパイルできる。
- [x] FFI module は所有パッケージの `other-modules` に置き、生の runtime 値を公開 API に漏らさない。

## 参考資料 (References)

- [Cabal User Guide: Modules included in the package](https://cabal.readthedocs.io/en/stable/cabal-package-description-file.html#pkg-field-library-other-modules)
- [ADR-0019](./0019-monorepo-package-layout.md)
- [ADR-0027](./0027-define-consumer-library-boundary.md)

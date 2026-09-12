# ADR-0018: ライブラリのバージョニング・リリース・配布方針を定める

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0011](./0011-outbound-http-fetch-backend.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md)

## 背景と課題 (Context)

本ライブラリは、Servant を Cloudflare Workers 上で動かすための公開ライブラリである。
下流のユーザがこれをどう依存・固定（pin）するかを定める必要がある。

固有の制約が二つある。第一に、本ライブラリは stock GHCup に含まれない GHC ネイティブ WASM
バックエンド（[ADR-0001](./0001-ghc-native-wasm-backend.md)）と専用ツールチェーンを前提とし、
post-linker（`post-link.mjs`）・`cabal`・`ghc-wasm-meta` のバージョンに追従する必要がある
（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) は「ツールチェーン更新時に追従が必要」、
[ADR-0015](./0015-build-deploy-ci-pipeline.md) はツールチェーンをロックする）。
ライブラリ単体は通常の `cabal` パッケージとして配布できるが、それを `wasm32-wasi` でビルドできるかは
利用側のツールチェーンに依存する。

第二に、公開する API 表面が広い。[ADR-0006](./0006-servant-execution-engine.md) の自前
`HasServer` 相当の型クラスと組み合わせ子、[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) /
[ADR-0008](./0008-cloudflare-platform-bindings.md) のバインディング層、
[ADR-0011](./0011-outbound-http-fetch-backend.md) の送信クライアント解釈系がそれである。これらは
型レベルプログラミングを多用するため、些細な変更が下流の型エラーになりやすく、何を破壊的変更と
みなすかを明文化しないと利用側が安全に固定できない。

加えて配布チャネルの選択には方針上の緊張がある。[ADR-0006](./0006-servant-execution-engine.md) は
先行実装 `servant-cloudflare-workers` を「Hackage 未公開で git 依存になり」保守を他者に委ねる点で
批判している。一貫性のため、本ライブラリは原則として Hackage 公開を目指すべきであり、もし git タグ
固定に留めるなら明確な理由が要る。

## 決定要因 (Decision Drivers)

- 下流が再現可能にバージョン固定（pin）でき、依存解決が破綻しないこと
- [ADR-0006](./0006-servant-execution-engine.md) の「Hackage 未公開・git 依存」批判と自己一貫すること
- 公開 API（自前 `HasServer` 相当・組み合わせ子・バインディング層・クライアント）の安定性が予測可能であること
- 各リリースが、どの GHC wasm / post-linker / `cabal` で構築・検証されたかを宣言できること
  （[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md)）
- ツールチェーンや Servant コアが更新された際の非推奨化・移行の手順が定まっていること
- Haskell エコシステムの慣行（Hackage / Package Versioning Policy）に沿うこと

## 検討した選択肢 (Considered Options)

1. **Hackage 公開 + Package Versioning Policy 準拠の semver + リリースごとのツールチェーン対応マトリクスを宣言する**
2. git タグのみで配布する（Hackage には公開しない）
3. ベンダリング／モノレポ専用とし、外部の利用者を想定しない

## 決定 (Decision)

採用する選択肢: **選択肢 1**

### 配布チャネル

本ライブラリは **Hackage 公開を第一級**とする。これは
[ADR-0006](./0006-servant-execution-engine.md) が `servant-cloudflare-workers` の「Hackage 未公開で
git 依存」を批判したことと自己一貫させるための決定である。ライブラリのソース自体は純 Haskell の
通常パッケージとして配布でき、`wasm32-wasi` でビルドできるかは利用側ツールチェーンの責務であるため、
非 stock ツールチェーン前提であることは Hackage 公開を妨げない。ただし次を明示する。

- パッケージ説明・README に「WASM（`wasm32-wasi`）専用、stock GHC では実行不可、ビルドは
  [ADR-0015](./0015-build-deploy-ci-pipeline.md) のツールチェーンを要する」旨を明記する。
- vanilla GHC でも型検査が通るよう、ホスト側互換の足場を維持する（リリース前検証を容易にする）。
- 各 Hackage リリースに対応する **注釈付き git タグ**（`vX.Y.Z`）を必ず併設し、Hackage 障害時や
  未公開の修正を一時的に固定したい利用者が git でも固定できる経路を残す。git は補助経路であり、
  正典は Hackage とする。

### semver（Package Versioning Policy）方針

バージョンは Haskell の Package Versioning Policy に準拠し `A.B.C.D` 形式（先頭二要素 `A.B` が
major、`C` が minor、`D` がパッチ）とする。公開 API 表面は以下を対象とし、破壊的変更を major 繰り上げと定義する。

- **サーバ解釈系**（[ADR-0006](./0006-servant-execution-engine.md)）: 自前 `HasServer` 相当の型クラス、
  その関連型・メソッドのシグネチャ、提供する組み合わせ子の型と意味論、`ServerError` 相当のエラー型と
  状態コード対応（404/405/406/415/400 等）。
- **バインディング層**（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md),
  [ADR-0008](./0008-cloudflare-platform-bindings.md)）: 公開 newtype・型付きアクセサのシグネチャ、
  `env` バインディング供給の型。
- **送信クライアント**（[ADR-0011](./0011-outbound-http-fetch-backend.md)）: クライアント解釈系の
  公開型クラスと生成されるクライアント関数の型。

破壊的変更（major 繰り上げ）の例: 公開型クラスのメソッド／関連型の追加・削除・シグネチャ変更、
組み合わせ子の意味論変更、エクスポートの削除・改名、既存 API 型の解釈結果の変化。
非破壊（minor）: 後方互換なエクスポート追加、新しい組み合わせ子の追加。
パッチ: 公開 API を変えない実装修正。型クラスはインスタンス追加だけでも下流をビルド不能にしうるため、
判断に迷う変更は major 扱いとする保守的運用をとる。

なお、**ツールチェーン対応マトリクスの変更（後述）は API 互換性とは独立の軸**として扱う。下限 GHC wasm の
引き上げのように API を変えずに前提だけが変わる更新は、変更ログとマトリクスに明記したうえで原則 minor
（実質的に既存利用者の再構築が必須となる場合は major）とする。

### ツールチェーン対応マトリクス

各リリースは、構築・検証に用いた **GHC wasm（`ghc-wasm-meta` 解決バージョン） / post-linker / `cabal`** の
組を「対応マトリクス」として宣言する。これは [ADR-0015](./0015-build-deploy-ci-pipeline.md) が固定する
ツールチェーンと一致させ、CI で検証した値をそのまま記録する。下限は GHC wasm 9.10（TH/ghci を使う
場合 9.12 以上）、`cabal` 3.14 以上を起点とする。

| 項目 | 宣言内容 |
| --- | --- |
| GHC wasm | 構築・テストに用いた `ghc-wasm-meta` 解決バージョン（下限と検証済み上限） |
| post-linker | 同梱 `post-link.mjs` の由来 GHC バージョン |
| cabal | 要求する最小 `cabal` バージョン |
| Servant コア | 再利用する `servant` / `servant-client-core` の対応バージョン範囲 |
| Cloudflare ランタイム | 検証済みの `compatibility_date` / workerd 系列 |

このマトリクスは README とリリースノートに記載し、CI の検証行列（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）と
同期させる。

### 非推奨化・移行プロセス

ツールチェーンまたは Servant コアが移動した際の手順を定める。

- ツールチェーン下限を引き上げる際は、変更ログで非推奨期間と移行先バージョンを告知し、対応マトリクスを更新する。
- 公開 API を変更する際は、可能な限り一つ前の major で `DEPRECATED` プラグマによる猶予を設けてから削除する。
- Servant コアの非互換更新には、対応マトリクスの `servant` 範囲更新と互換性テスト
  （[ADR-0006](./0006-servant-execution-engine.md) の `servant-server` 互換性検証）の再実行で追従する。

## 結果 (Consequences)

### 良い結果 (Positive)

- Hackage 公開により下流は通常の依存解決で固定でき、[ADR-0006](./0006-servant-execution-engine.md) の
  「git 依存になる」批判と自己一貫する。
- Package Versioning Policy 準拠で、型レベル API の破壊的変更が major 繰り上げとして予測可能になる。
- 対応マトリクスにより、各リリースが動作保証するツールチェーンが明示され、利用側のビルド失敗を未然に防げる。
- git タグ併設で Hackage 障害時の固定経路も残る。

### 悪い結果・トレードオフ (Negative)

- Hackage 公開・リリースノート・対応マトリクス維持の継続的な運用コストが生じる。
- 非 stock ツールチェーン前提のパッケージは、Hackage 上でビルド検証（Hackage の Haddock/ビルドボット）に
  通らない可能性があり、ドキュメント生成や評判面で注意が要る。
- 型クラス中心の API は保守的に major 扱いとする運用ゆえ、メジャー番号の進行が速くなりうる。

### 中立・フォローアップ (Neutral / Follow-up)

- 初回リリース時点の対応マトリクス具体値（GHC wasm / post-linker / `cabal` の確定バージョン）を
  [ADR-0015](./0015-build-deploy-ci-pipeline.md) と突き合わせて確定する。
- Hackage の自動ビルド・Haddock 生成が非 stock ツールチェーンで失敗する場合の回避策（説明文での明示、
  外部ホストの API ドキュメント）を検討する。
- API 安定性を機械検証する手段（公開 API のスナップショット差分）を CI に組み込む余地がある。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### Hackage 公開 + Package Versioning Policy + 対応マトリクス

- 利点: エコシステム標準の固定手段が使え、[ADR-0006](./0006-servant-execution-engine.md) の批判と自己一貫する。
  semver と対応マトリクスで API・ツールチェーン双方の互換性が予測可能になる。
- 欠点: 公開・変更ログ・マトリクスの運用コスト。非 stock 前提ゆえ Hackage 側のビルド検証に通らない懸念。

### git タグのみで配布

- 利点: 公開手続きが不要で、ツールチェーン依存のパッケージを手軽に固定提供できる。
- 欠点: まさに [ADR-0006](./0006-servant-execution-engine.md) が批判した「Hackage 未公開で git 依存」に
  自らが陥り、自己一貫しない。下流は `source-repository-package` 等での固定を強いられ、依存解決やツール
  連携が弱くなる。

### ベンダリング／モノレポ専用

- 利点: 外部互換性の制約から解放され、内部で自由に変更できる。
- 欠点: 「公開ライブラリとして提供する」という本プロジェクトの目的に反し、外部利用者が固定・再利用できない。

## 遵守事項 (Compliance)

- [ ] ライブラリを Hackage に公開し、各リリースに注釈付き git タグ `vX.Y.Z` を併設する。
- [ ] バージョンは Package Versioning Policy（`A.B.C.D`）に準拠し、公開型クラス・組み合わせ子・バインディング層・
      クライアントの破壊的変更を major 繰り上げとして変更ログに記録する。
- [ ] 各リリースに GHC wasm / post-linker / `cabal` / `servant` コアの対応マトリクスを README とリリースノートに記載し、
      CI 検証行列（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）と一致させる。
- [ ] 公開 API 削除前に一つ前の major で `DEPRECATED` の猶予を設ける（不可避な場合はその理由を変更ログに記す）。
- [ ] パッケージ説明に WASM（`wasm32-wasi`）専用・stock GHC では実行不可・要ツールチェーンを明記する。

## 参考資料 (References)

- Haskell Package Versioning Policy（PVP）: https://pvp.haskell.org/
- Hackage — The Haskell Package Repository: https://hackage.haskell.org/
- GHC User's Guide — WebAssembly backend（非 stock ツールチェーン前提）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Tweag — Template Haskell and GHCi for Wasm（GHC 9.12 / cabal-3.14 の前提）: https://www.tweag.io/blog/2024-11-21-ghc-wasm-th-ghci/
- konn/ghc-wasm-earthly（`servant-cloudflare-workers` は Hackage 未公開・設計参照のみ）: https://github.com/konn/ghc-wasm-earthly
- [調査メモ](../research/feasibility-servant-on-cloudflare-workers.md)（`servant-cloudflare-workers` の Hackage 未公開・git 依存）

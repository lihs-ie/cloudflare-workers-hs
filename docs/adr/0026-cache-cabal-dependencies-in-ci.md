# ADR-0026: CI の Cabal 依存キャッシュをホストと WASM に分離する

- ステータス: 承認
- 日付: 2026-09-13
- 決定者: cloudflare-workers-hs 開発チーム
- 関連: ADR-0015, ADR-0017

## 背景と課題 (Context)

CI はホスト GHC と `wasm32-wasi-ghc` の両方で Cabal を実行する。既存のキャッシュは
ホストの `~/.cabal/store` とビルド生成物だけであり、WASM ジョブには Cabal キャッシュが
なかった。また、`haskell-actions/setup` と各ジョブの明示的な `cabal update` により、固定済みの
パッケージ索引を毎回更新していた。

`cabal.project` と `cabal-wasm.project` は同じ `index-state` を固定している。依存物のビルドを
再利用しつつ、その固定値が変わったときだけ索引を更新できるようにする。

## 決定要因 (Decision Drivers)

- ホストと WASM の依存ビルドを独立に再利用できること
- `index-state` による再現可能な依存解決を維持すること
- ソース変更後に古いプロジェクト生成物を復元しないこと
- Nix ストア用の外部キャッシュ基盤を追加しないこと

## 検討した選択肢 (Considered Options)

1. 既存の `~/.cabal/store` とビルド生成物の単一キャッシュを維持する
2. ホスト／WASMの専用 `CABAL_DIR` に索引と依存ストアを分離してキャッシュする
3. Nix ストアを含めてキャッシュする

## 決定 (Decision)

採用する選択肢: **2. ホスト／WASMの専用 `CABAL_DIR` に索引と依存ストアを分離してキャッシュする**

各CIジョブはホスト用とWASM用の `CABAL_DIR` を `runner.temp` 配下で分離する。各ディレクトリの
`packages` と `store` を別々の `actions/cache` エントリとして保存する。WASM用の設定ファイルは
`wasm32-wasi-cabal` に生成させる。このラッパーが供給するクロスコンパイル用の `shared: True` などの
設定を、汎用の `cabal user-config init` で置き換えてはならない。キャッシュキーにはジョブ名を含め、
並列ジョブ間で部分的な依存ストアを競合保存しないようにする。索引キーには `index-state`、依存ストア
のキーにはOS、アーキテクチャ、ツールチェーン、依存定義を含める。

`haskell-actions/setup` の自動更新は無効化し、索引キャッシュのミス時だけ該当する `cabal update`
を実行する。`dist-*` などプロジェクトのビルド生成物はキャッシュしない。

キャッシュヒット後の待ち時間を減らすため、状態モデル検証は独立ジョブで実行し、summaryの必須条件に
含める。独立ジョブでは同じcheckoutからruntimeを生成し、別ジョブの未検証成果物には依存しない。
統合ジョブ内では `WASM_BUILD_DIR=dist-newstyle-runtime` を共有し、example間の共通ライブラリを
再利用する。このディレクトリはジョブ内でのみ共有し、実行間のキャッシュには含めない。
Docker内のexampleスイートは別々のポート・一時ストレージを利用して並列実行する。各スイート内は
逐次実行を維持し、全プロセスの終了を待ってから結果を判定する。

## 結果 (Consequences)

### 良い結果 (Positive)

- キャッシュヒット時はホスト・WASMとも依存物の再ビルドと索引更新を省略できる
- クロスコンパイラのストアがホスト用ストアへ混在しない
- ソース変更時もプロジェクト自身は新規にビルドされる

### 悪い結果・トレードオフ (Negative)

- 初回実行と依存定義・`index-state`・ツールチェーン変更後の実行はキャッシュミスになる
- ホスト用とWASM用にそれぞれキャッシュ容量を消費する
- Nix開発シェルの取得時間はこの決定では短縮しない

### 中立・フォローアップ (Neutral / Follow-up)

- Nixストアの共有が必要になった場合は、容量・権限・外部キャッシュ基盤を別途評価して決定する

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 1. 既存の単一キャッシュを維持する

- 利点: 設定変更が不要
- 欠点: WASM依存物を再利用できず、ビルド生成物と依存物のライフサイクルが混在する

### 2. ホスト／WASMの専用 `CABAL_DIR` に索引と依存ストアを分離する

- 利点: ツールチェーン境界を保ったまま、依存物だけを再利用できる
- 欠点: CI定義にキャッシュ初期化手順が追加される

### 3. Nix ストアを含めてキャッシュする

- 利点: Nix開発シェルの取得も短縮できる可能性がある
- 欠点: Cabalキャッシュとは異なる容量・権限・キャッシュ基盤の設計が必要になる

## 遵守事項 (Compliance)

- [x] `haskell-actions/setup` では `cabal-update: false` を指定する
- [x] `cabal update` は対応する索引キャッシュのミス時だけ実行する
- [x] ホスト用とWASM用の `CABAL_DIR`、索引、依存ストアを分離する
- [x] `dist-*` とNixストアを `actions/cache` の対象に含めない

## 参考資料 (References)

- [haskell-actions/setup](https://github.com/haskell-actions/setup)
- [GitHub Actions cache](https://github.com/actions/cache)

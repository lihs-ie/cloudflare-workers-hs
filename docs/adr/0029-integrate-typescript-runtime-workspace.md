# ADR-0029 TypeScript runtime を pnpm ワークスペースに統合する

- ステータス — 承認
- 日付 — 2026-11-21
- 決定者 — lihs
- 関連 — [ADR-0018](./0018-versioning-release-distribution.md)、[ADR-0019](./0019-monorepo-package-layout.md)、[ADR-0025](./0025-separate-typescript-runtime-repository.md)

## 背景

ADR-0025 で TypeScript runtime を別リポジトリに移した。ライブラリ側は runtime のコミット SHA を固定し、その組み合わせを実 WASM/workerd で検証してきた。ライブラリ側の依存監査では、固定先リポジトリの開発依存は別途確認する必要があった。Haskell と runtime の境界をまたぐ変更には、runtime 側の変更とライブラリ側の固定 SHA の更新が必要だった。

## 決定

`@cloudflare-workers-hs/runtime` のソースを `packages/runtime` に置く。パッケージ名と公開 ESM エントリポイントを維持する。サンプルとテストは `workspace:*` で依存し、ルートの pnpm ロックファイル、Node・pnpm のバージョン、CI の依存監査を共有する。CI で runtime のテストと Haskell/WASM 統合テストを実行する。

外部プロジェクトは、試運転中の配布経路として `github:lihs-ie/cloudflare-workers-hs#<SHA>&path:/packages/runtime` を使う。pnpm がビルドを要求した場合は、検証した SHA とパスに対応するパッケージキーだけを `allowBuilds` に登録する。CI は checkout した Git コミットをワークスペースの外からインストールして、公開 API の import と WASM reactor の初期化を検証する。

旧リポジトリは既存の SHA 固定参照のために残す。新規の保守はこのリポジトリの `packages/runtime` で行う。本 ADR は ADR-0025 のソース配置と Git 配布元に関する判断を置き換える。

## 結果

Haskell、JSFFI、runtime を同じ PR の組み合わせで検証できる。Node の開発依存も共通のロックファイルで監査できる。runtime は独立した npm パッケージとしてビルド・配布できる。試運転中に Git 経由で利用する場合は、引き続き利用側のインストール時にビルドする。

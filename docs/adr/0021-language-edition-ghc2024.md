# ADR-0021: 全パッケージの default-language を GHC2024 に統一する

- ステータス: 承認
- 日付: 2026-07-22
- 決定者: lihs
- 関連: [ADR-0001](./0001-ghc-native-wasm-backend.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md), [ADR-0017](./0017-testing-strategy.md), [ADR-0019](./0019-monorepo-package-layout.md)

## 背景と課題 (Context)

skeleton は当初 `GHC2021` を `default-language` として書き起こされていたが、upstream repo
（[ADR-0006](./0006-servant-execution-engine.md) が設計参照とする konn 系リポジトリ、および開発が
参照する周辺実装）は `GHC2024` を用いており、両者に乖離が生じていた。

`GHC2024` は `GHC2021` に対して `DataKinds` / `DerivingStrategies` / `GADTs`（`MonoLocalBinds` 連動）/
`LambdaCase` 等を新たに default 化した言語版である。本ライブラリは型レベル API DSL
（[ADR-0006](./0006-servant-execution-engine.md)）・[ADR-0019](./0019-monorepo-package-layout.md) の
`*.Internal.*` 機構で `DataKinds`/`GADTs` を多用するため、各パッケージの `.cabal` に個別の
`default-extensions` として重複宣言している状態だった。ツールチェーンは GHC 9.12.2 に固定済み
（[ADR-0001](./0001-ghc-native-wasm-backend.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md)）であり、
`GHC2024` をサポートする。

## 決定要因 (Decision Drivers)

- upstream/設計参照実装との乖離を縮小し、貢献者が前提なくコードを読めること
- 型レベル API DSL・`*.Internal.*` 機構が要求する拡張（`DataKinds`/`GADTs`/`DerivingStrategies`/
  `LambdaCase` 等）を、パッケージごとの `default-extensions` 重複宣言なしに得られること
- 固定済みツールチェーン（GHC 9.12.2、[ADR-0001](./0001-ghc-native-wasm-backend.md)/
  [ADR-0015](./0015-build-deploy-ci-pipeline.md)）が対象言語版をサポートすること
- [ADR-0019](./0019-monorepo-package-layout.md) の4パッケージ + `examples/quickstart` +
  （dev-only）`conformance-oracle`（[ADR-0017](./0017-testing-strategy.md) 追補）間で言語版が
  一致し、ドリフトを生まないこと

## 検討した選択肢 (Considered Options)

1. **全パッケージ（library/executable/test-suite）で `default-language: GHC2024` に統一する**
2. `GHC2021` を維持し、不足する拡張のみ各パッケージの `default-extensions` に個別追記する
3. パッケージ単位で言語版を分ける（型レベル機構を多用するパッケージのみ `GHC2024`、他は `GHC2021`）

## 決定 (Decision)

採用する選択肢: **選択肢 1**

全パッケージ（`cloudflare-workers` / `servant-cloudflare-workers` /
`servant-cloudflare-workers-client` / `servant-cloudflare-workers-access`、および
`examples/quickstart`、dev-only `conformance-oracle`）の library / executable / test-suite
stanza すべてで `default-language: GHC2024` を用いる。`GHC2024` に含まれるようになった拡張と
重複する `default-extensions` エントリは削除する。

## 結果 (Consequences)

### 良い結果 (Positive)

- upstream/設計参照実装と言語版が一致し、貢献者の認知負荷が下がる。
- パッケージごとに重複していた `default-extensions` 宣言（`DataKinds`/`GADTs`/
  `DerivingStrategies`/`LambdaCase` 等）を削除でき、`.cabal` の保守面が減る。
- 実測では、既存コードに型注釈を一切追加せず `GHC2024` へのビルドが通過した（下記 Negative 参照）。

### 悪い結果・トレードオフ (Negative)

- `MonoLocalBinds` により局所束縛（`let`/`where`）の多相推論が制限される。今回の実測では既存
  コードへの注釈追加ゼロで通過したが、コードベースが成長するにつれて将来的な摩擦（型注釈の
  追加が必要になる局面）が生じ得る。
- `GHC2024` は Haskell2010 ほど強い安定性保証を持たない（GHC User's Guide が明記する非標準化拡張
  の集合であるため）。将来 GHC バージョンで拡張の集合が変わるリスクを、`GHC2021` 据え置きより
  多く引き受ける。

### 中立・フォローアップ (Neutral / Follow-up)

- 教材側（pschool コース、本リポジトリの外部成果物）は `GHC2021` を前提に既存章が書かれており、
  本決定との乖離が生じる。新規 section で `GHC2021` → `GHC2024` の移行差分（特に
  `MonoLocalBinds`/`DataKinds`/`GADTs` の default 化）を教材化する。これは本リポジトリの外の
  作業であり、本 ADR は事実の記録のみを行う。
- 各パッケージの `.cabal` から `default-extensions` の重複エントリを削除する作業は、本決定の
  実装作業として別途進める。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 全パッケージ `GHC2024` 統一

- 利点: upstream 一致、`default-extensions` 重複削除、パッケージ間の言語版ドリフトを構造的に排除。
- 欠点: `MonoLocalBinds` 等の挙動変化を全パッケージが一律に引き受ける。

### `GHC2021` 維持 + 個別拡張追記

- 利点: 既存の安定した言語版を保てる。`MonoLocalBinds` の挙動変化を回避できる。
- 欠点: upstream との乖離が残る。パッケージごとの `default-extensions` 重複が解消されない。

### パッケージ単位で言語版を分ける

- 利点: 型レベル機構を多用するパッケージのみ恩恵を受け、他は変更を最小化できる。
- 欠点: パッケージ間で言語版が割れ、貢献者が「このパッケージは何版か」を都度確認する必要が
  生じる。[ADR-0019](./0019-monorepo-package-layout.md) が目指す一貫した構造方針とも整合しにくい。

## 遵守事項 (Compliance)

- [ ] 全パッケージ（`cloudflare-workers` / `servant-cloudflare-workers` /
      `servant-cloudflare-workers-client` / `servant-cloudflare-workers-access` /
      `examples/quickstart` / dev-only `conformance-oracle`）の `.cabal` の library / executable /
      test-suite すべての stanza で `default-language: GHC2024` を明記する。
- [ ] `GHC2024` に含まれるようになった拡張と重複する `default-extensions` エントリを削除する。
- [ ] 固定済み GHC 9.12.2（[ADR-0001](./0001-ghc-native-wasm-backend.md)/
      [ADR-0015](./0015-build-deploy-ci-pipeline.md)）が `GHC2024` をサポートすることを前提とし、
      ツールチェーン更新時は `GHC2024` サポートの継続を確認する。

## 参考資料 (References)

- GHC User's Guide — Controlling editions and extensions（`GHC2021`/`GHC2024` の定義・含まれる拡張）: https://downloads.haskell.org/ghc/latest/docs/users_guide/exts/control.html#controlling-editions-and-extensions
- GHC User's Guide — WebAssembly backend: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html

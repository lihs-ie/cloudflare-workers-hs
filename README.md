# cloudflare-workers-hs

HaskellからCloudflare Workersを扱うライブラリです。テスト基盤はSydtest 0.28とHedgehogを使い、実WASM/workerdの検証を分離しています。

## テストの実行

host側はGHC 9.14.1とCabal、実ランタイム側はGHC WASM・Node・pnpmが必要です。host専用の`testing-support`と`conformance-oracle`は出荷依存に含めません。

```sh
cabal update
just setup-js
just test-registration
just test-tools
just test-host
just test-conformance
just test-integration
just test-model
just test-dev
just test-docker
just test-library-examples
just test-coverage
just test-mutations
```

`just test-integration`はテスト専用reactorと本番quickstartの両方を実行します。`just test-model`はテスト専用reactorをビルドし、試行ごとに新しいworkerd状態で操作列を検証します。テスト専用reactorの成功を本番APIの成功とは扱いません。

`just test-coverage`は100%目標を満たさない場合に失敗します。調査目的で未達レポートを取得する場合は`just test-coverage-report`を使いますが、テスト失敗はこのコマンドでも成功に変わりません。HPCのhost測定とWASM・JS・補助ツールの測定は別々に報告します。

実行コマンド・seed・試行数・ログは`artifacts/testing/`に保存します。反例は失敗ログから確認し、同一ツールチェーンとソースで再実行します。

```sh
just test-replay cloudflare-workers:test:unit 73
python3 scripts/testing/run.py replay --target servant-cloudflare-workers:test:conformance --seed 73 --match routing
python3 scripts/testing/run.py host --seed 20260907 --examples 1000
```

macOSでHPCのC stubに必要な`ffi.h`が見つからない場合、共通コマンドは既存のHomebrew libffi includeを利用します。GHC WASMは既存の`~/.ghc-wasm/env`、または`nix develop`の固定環境を使用します。

## ファイル配置

- 単体テストは`test/unit/`内で実装モジュールの階層に対応する`*Spec.hs`へ配置します。
- 入口だけを自動検出し、責務で分割した`*Cases.hs`を入口から一度だけ登録します。
- TypeScriptは同じ原則で`*.spec.ts`と`*.cases.ts`を使用します。
- 補助コードはパッケージごとの`test/Support/**`、固定データは`Support/Fixtures/**`、期待値は`Support/Golden/**`に集約します。
- 固定・プロパティ・回帰テストは同じ振る舞いなら同じファイルに置きます。

`just test-registration`は入口・子ファイル・Cabal登録を静的照合します。実際の実行結果は各ランナーのログで確認します。登録検査だけで実行済みとは扱いません。

詳細は[実装計画](docs/specs/testing-modernization-plan.md)、[検証状況](docs/specs/testing-modernization-status.md)、[quickstartテスト](examples/quickstart/test/README.md)、[カバレッジ収集器](scripts/testing/Support/coverage.md)を参照してください。

`just test-dev`は本番WASMをビルドして独立Worker群を`wrangler dev`で起動し、実HTTP経由で検証します。`just test-docker`は同じ検証をDocker内で実行します（Docker daemonが必要）。どちらも`artifacts/testing/`に実行ログと証拠を保存し、起動・検証失敗を成功として扱いません。CIでも両レーンを実行します。

`just test-library-examples`は用途別ライブラリ実行例のWASMをビルドし、実際の`wrangler dev`で検証します。`just test-docker`もQuickstartとライブラリ実行例の両方を事前ビルドし、両スイートをコンテナ内で実行します。

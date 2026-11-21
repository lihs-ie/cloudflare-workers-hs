# テストの構成

保証する契約を持つパッケージにテストを置きます。実行に必要なWorkerの組み立てだけをリポジトリ共通の場所へ分離します。

```text
cloudflare-workers/test/              # Workers Binding / HTTP / Entrypoint
servant-cloudflare-workers/test/      # Router / Server
servant-cloudflare-workers-client/test/ # Client / Retry
servant-cloudflare-workers-access/test/ # Access / Crypto / JWKS
  unit/                              # ホストで実行する純粋な契約
  conformance/                       # 対応するパッケージの互換性検証
  integration/runtime/               # 実WASM/workerdで実行する契約
  Support/                           # そのパッケージのfixture

tests/runtime/                       # 開発専用のライブラリ契約実行環境
  app/Main.hs                        # ライブラリfixtureのexportを合成
  harness.ts                         # WASM/Binding/DOの接続
  model/                             # モデル検証のNodeブリッジ
  test/model/                        # Haskellから実ランタイムへ状態列を適用

scripts/testing/                     # ローカル・CI・証跡収集の入口
  Support/                           # 起動停止、計測、入力ハッシュ検証
  test/                              # テスト基盤自身のNodeテスト

examples/<name>/
  test/unit/                         # example固有のドメイン/API契約
  test/integration/                  # アプリケーションの実ランタイム検証
  test/Support/                      # そのexample専用の障害注入・テスト用reactor
```

ライブラリ契約用`library-runtime`、URL短縮アプリのfixture用`runtime-tests`、公開するアプリケーション用reactorは別々にビルドします。ライブラリ用reactorにexampleのソースを組み込みません。`testing-support`はテスト探索だけを扱い、exampleのAPIをコンパイルしません。

JavaScriptの手書きテスト・実行補助はTypeScriptへ統一します。Node用は`.mts`、Worker用は`.ts`です。生成JSFFIとWrangler生成型定義を手で修正しません。外部JSON・動的なテスト代替モジュールは`unknown`で受け、値・メソッドを検証します。部分的に壊れたネイティブBindingを渡すテストは、完全なCloudflare型への型アサーションを使わず、検証した動的境界で呼び出します。

## 実行

Nodeとpnpmは`.node-version`と`package.json`で固定しています。CI・Nix・Dockerでも同じバージョンを使います。リポジトリルートで`pnpm install --frozen-lockfile`を実行します。WASMビルドには`wasm32-wasi-cabal`、ホストテストにはプロジェクト指定のGHCが必要です。api-catalogのローカルTLS fixtureにはOpenSSLを使います。Dockerイメージには含めています。

| コマンド | 確認すること |
| --- | --- |
| `pnpm typecheck` | Wranglerの構成別型、全example、共通ツール、ライブラリランタイムの型 |
| `pnpm test:tools` | Nodeでテスト基盤の実動作を検証 |
| `just test-tools` | Nodeでテスト基盤を検証 |
| `node scripts/testing/registration.mts` | テスト入口と分割caseの静的登録 |
| `node scripts/testing/test-boundaries.mts` | exampleとライブラリ・共通基盤の依存方向 |
| `node scripts/testing/run.mts host` | ホスト単体テストと探索の契約 |
| `node scripts/testing/run.mts conformance` | Servantとの互換性 |
| `pnpm --dir tests/runtime build:runtime` | ライブラリ契約用reactorの生成 |
| `pnpm --dir tests/runtime test:runtime` | ライブラリの実WASM契約 |
| `node scripts/testing/run.mts model` | 実WASMを使った状態モデル検証 |
| `node scripts/testing/run.mts integration` | ライブラリ、アプリfixture、本番構成の統合検証 |
| `just test-docker` | 7例のLinux workerd検証 |

各exampleの実行方法は[examples/README.md](examples/README.md)を参照してください。

## 証跡とカバレッジ

ビルド前後の入力ハッシュ、WASM/JSFFIのハッシュ、モデル用bundleを検査します。古い生成物やビルド中に変わった入力を受理しません。`.dev-test-*`、依存物、生成WASM・JSFFI、計測出力はビルド入力から除きます。

HaskellのホストHPC、実WASMのHPC、workerdのIstanbul、NodeのIstanbul/V8を区別します。Nodeで代替Bindingを使った成功はCloudflareでの成功として扱いません。ライブラリのWorker TypeScriptは独立ランタイムのVitestレポート、exampleの共有TypeScriptはNode/workerdの同一instrumenter、Node専用の`.mts`はV8で計測します。同じファイルへ異なるinstrumenterのmapを重ねません。同じinstrumentation mapを使うNode/workerdの統合には、ソース・map・snapshot・コマンド証跡の一致を要求します。測定されていないファイルを実行済みとして扱いません。

Workflowの計測では、キャンセルによって終了した実行コンテキストから通信しません。完了時のカウンターをメモリに保存し、プロセス停止前に別のHTTP要求で回収してホストから送信します。停止時にまだ待機中の実行を、完了済みの計測として扱いません。


計測は次の順序で実行します。WASM計測用ビルドと通常ビルドは同じ生成物を更新するため、並行して実行しません。

1. `node scripts/testing/example-node-coverage.mts --tools-only`でテスト基盤の行・分岐・関数をV8/c8で計測します。テストが起動するNodeの子プロセスも対象です。
2. `node scripts/testing/shell-coverage.mts --output artifacts/testing/shell-coverage-<run>`で8つのビルドスクリプトを実Bash/kcovで計測します。コンパイラ・post-link・manifestは外部境界の代替です。シェルの分岐率は未計測のまま残します。
3. `node scripts/testing/compile-validation.mts`で18の型宣言・型契約を検証します。型宣言に実行カバレッジの割合を付けません。
4. `node scripts/testing/native-tools-coverage.mts`でネイティブCLIとGHCプラグインを実行・計測します。
5. `node scripts/testing/wasm-coverage.mts --all-examples`でライブラリと7例のHaskellを実WASMで計測します。
6. 通常ビルドを復元して、統合テスト・`workerd-js-coverage.mts`・`shared-node-coverage.mts`・`example-node-coverage.mts`の証跡を採取します。
7. `node scripts/testing/run.mts coverage --skip-runtime-build --report-only`でホストHPCを採取し、現在の入力と一致する各collectorの最新証跡を集約します。

集約だけをやり直す場合は`node scripts/testing/run.mts coverage --host-proof artifacts/testing/<run>/host/proof.json --report-only`を使います。ホストの再実行やモデルの再ビルドは行いません。WASM・Node/workerd・型検証・シェルの証跡を自動探索し、改変・失敗・入力不一致の証跡を受理しません。`--report-only`の終了成功はカバレッジ達成を意味しません。生成レポートの`errors`・`unmeasured_sources`・`complete`を確認します。

Imagesの実WASMテストでは、Binding境界へ制御可能な代替サービスを渡し、画像情報・変換順序・出力形式・アニメーション・ストリームと異常応答を検証します。Cloudflare上の画像変換サービス自体の動作保証とは区別します。

Haskellの型・再exportは`haskell-interface`、探索用`Spec.hs`は`haskell-test-entry`として分類します。前者はソースを固定した実GHCインターフェースと公開APIの正負コンパイル検証、後者は対応するCabal suiteの非空・成功した実行を要求します。0式を実行100%にする例外は設けません。

WASM collectorはコンパイラ実体・target・バージョン・toolchain設定と各build planを保存します。同一ソース、同一コンパイラ、同一ランタイム、完全に同じラベル付きtick mapのreactorだけを集約します。CPPを含むソースはcomponent間投影しません。

ホストHPCとWASM採取後、`node scripts/testing/haskell-validation.mts --host-proof <host/proof.json> --wasm-proof <wasm/proof.json>`でHaskell契約を検証し、`run.mts coverage --host-proof ... --report-only`で再集約します。型契約・探索契約は実行カバレッジの割合を持ちません。

`otherwise`のFalse側は、`runtime-scope.json`にソースの指紋と正確なGuardBinBox位置を記録したものだけを到達不能として区別します。元のmetricsとカウンターはレポートに保持します。未知の条件・変更されたソース・False側に実カウンターがある条件を自動免除しません。

Node計測はSupport以下の既存specを再帰的に実行し、実Vitest起動・configured HTTP契約もV8の収集下に置きます。WASM計測時のlibrary-runtime JavaScriptレポートも保存し、通常実行では読み込まれないcoverage setupの証跡を保持します。

Nodeの契約テストで使う`?contract=...`付きfile URLは、対象ソースの指紋を確認した上でc8用のURLだけを正規化します。元のV8カウンターを保持し、正規化前後のJSONを証跡に保存します。集約時には変換を再現して、URL以外のカウンター変更がないことを検証します。

Accessの11個の共有JWKSCacheシナリオは、Hostと開発専用WASM componentの両方で実行します。WASM componentではAccess所有のJWKS/JWKSCacheソースを直接コンパイルします。公開パッケージのInternal可視性は、外部consumerのコンパイル失敗テストで検証します。

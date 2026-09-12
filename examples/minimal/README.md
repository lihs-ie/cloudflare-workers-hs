# 最小のHaskell Worker

最初に読む例です。`NamedRoutes`で定義した1つのAPIハンドラが、`GET /health`へ`{"status":"ok"}`を返します。Binding・認証・データベースは不要です。実用アプリは[Quickstart](../quickstart/README.md)、用途別の機能は[library-examples](../library-examples/README.md)を参照してください。

## ファイル

- `src/Minimal/API.hs`: NamedRoutesとJSON応答型。
- `src/Minimal/Application.hs`: APIハンドラ。
- `app/Main.hs`: WorkerのfetchとServantの配線。
- `worker/runtime.ts`: GHCのWASMとWASIの初期化。
- `worker/index.ts`: Wranglerが読み込む入口。
- `wrangler.jsonc`: Binding不要のWorker設定。
- `test/integration/http.spec.mjs`: 実wrangler devで200・JSON本文・404・405を確認。
- `test/Support/build-manifest.mjs`: ビルド前後の入力ハッシュとWASM・JSFFI生成物のハッシュを記録し、古い生成物や改変された生成物をテスト開始前に拒否。
- `test/Support/dev.mjs`: 一時ポート・ローカル状態・プロセスの起動と後片付け。

## リポジトリ内で実行

リポジトリルートでWASM GHC環境を用意し、Node.jsとpnpmをインストールします。JavaScript依存はQuickstartと共有します。

```sh
just setup-js
bash examples/minimal/scripts/build.sh
node --test --test-concurrency=1 examples/minimal/test/integration/*.spec.mjs
```

手動で試す場合:

```sh
cd examples/quickstart
pnpm exec wrangler dev --config ../minimal/wrangler.jsonc --port 8787
```

別ターミナルで`curl http://localhost:8787/health`を実行します。

## 独立したプロジェクトにする場合

`app/`、`src/`、`worker/`、`minimal-worker.cabal`、`wrangler.jsonc`がアプリの構成要素です。テストを使う場合は`test/`もコピーします。生成済みの`.wasm`と`*-jsffi.mjs`はコピー元のソースを変更したら再生成してください。テストには対応する`worker/build.json`も必要です。Dockerで事前ビルド済み生成物を使う場合も、入力・生成物の一致検査を省略しません。

独立先では次を用意・変更します。

- `cabal.project`/WASM用projectファイルで、このパッケージと`cloudflare-workers`・`servant-cloudflare-workers`を参照する。GHCと依存の固定値はルートの`cabal-wasm.project`を基準にする。
- `package.json`のruntime依存を`workspace:*`から公開バージョン（未公開期間は提供されたtarball）に変更し、`wrangler`を追加する。WASI shimはruntime自身の依存なので直接導入する必要はない。
- runtimeは引き続き`@cloudflare-workers-hs/runtime`でimportする。利用側の`pack`実行は不要。
- `wrangler.jsonc`の`$schema`とテストのWrangler実行パスを独立先の`node_modules`へ変更する。
- `scripts/build.sh`のリポジトリルート・projectファイル・生成先と、`test/Support/build-manifest.mjs`の入力一覧を独立先に合わせる。

このディレクトリはリポジトリ内の最小実行例であり、そのままコピーするだけで依存まで揃うテンプレートではありません。

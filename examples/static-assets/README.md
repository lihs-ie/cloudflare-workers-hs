# Static AssetsとHaskell API

同じWorkerから静的なHTML・JavaScript・CSSと、NamedRoutesのJSON APIを配信します。画面の「APIの状態を確認」ボタンからHaskell APIを呼び出せます。

```sh
# リポジトリルート
just test-static-assets
# 画面を開く場合
cd examples/static-assets
../quickstart/node_modules/.bin/wrangler dev --local --config wrangler.jsonc
# http://localhost:8787/
```

## 構成

- `public/`: HTML・JS・CSS。WranglerがAssetsとして配信するファイル。
- `src/StaticAssets/API.hs`: `GET /api/health`を持つ1つのNamedRoutes API。
- `src/StaticAssets/Application.hs`: APIのハンドラ。パスの再判定やAssets向けのRawハンドラは不要。
- `app/Main.hs`: 型付き`ASSETS` Bindingと`serveWithAssets [["api"]]`でAPI・Assetsを接続。
- `worker/`: WASIの起動コードと生成WASM/JSFFI。
- `wrangler.jsonc`: AssetsディレクトリとBinding、`run_worker_first: true`を指定。
- `test/integration/assets.spec.mjs`: 実Wranglerで配信・API優先・HEAD・条件付きGET・404を検証。

Assetsは`Cloudflare.Workers.Binding.Assets`の`Assets`と`assetsFetch`で扱えます。Request・Responseを使い、ストリーミング本文とネイティブのヘッダーを維持します。通信失敗は`AssetsError`となります。公開API `Servant.Cloudflare.Workers.Assets.serveWithAssets` は失敗を呼出元へ伝え、例外ポリシーはアプリ側で設定できます。

`/api`を予約し、APIの入力をHTMLにフォールバックさせません。404・405・406やハンドラの認証拒否はAPIの応答をそのまま保持します。予約パスはデコード済みセグメントのリストで指定し、`/apiary.txt`は`/api`に含みません。同じパスの静的ファイル`public/api/health`はAPI優先を検証するための固定入力です。SPAフォールバックはこの例では無効です。静的ファイルが見つからなければ404になります。

`run_worker_first: true`により全リクエストがHaskellを通る構成です。静的ファイルを先に配信する構成ではWorkerの呼び出しが変わるため、用途に合わせて[公式のAssetsルーティング](https://developers.cloudflare.com/workers/static-assets/binding/)を確認してください。

ビルドは`bash examples/static-assets/scripts/build.sh`。Cabal・JS依存はリポジトリで共用し、ビルド時に`public/`を含むソースとWASM/JSFFIをハッシュ化します。Dockerも同じ成果物の鮮度を検査します。

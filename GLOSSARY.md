# Glossary

- **reactor**: WASI commandとは異なり、初期化後にexport関数を繰り返し呼び出すGHC WASM module。
- **JSFFI**: HaskellとJavaScriptの値・関数を接続するGHC WebAssembly foreign-function interface。
- **runtime package**: reactorのWASI初期化とCloudflare entrypoint接続を担う`@cloudflare-workers-hs/runtime`。
- **host testkit**: vanilla GHC上でCloudflare境界の純粋な契約を検証する補助library。
- **workerd**: Cloudflare Workers runtimeのオープンソース実装。WranglerとVitest poolの実行基盤。
- **NamedRoutes**: Servant APIをrecord-of-routesとして宣言し、対応するhandler recordへ接続する方式。
- **Cloudflare Binding**: CloudflareまたはWranglerが設定し、platform resourceまたはcapabilityとしてWorkerの`env`へ供給する値。単にJavaScript objectが`env`に存在するだけではBindingとは呼ばない。
- **Workers Runtime API**: Request、Response、fetch、Cache、stream、socket、Web Cryptoなど、Worker内で利用できるが`env` Bindingではないruntime capability。
- **Application dependency**: npm package、SDK、またはアプリコードが構築するclient/object。Cloudflare公式docsで紹介されていてもBindingにはならない。`aws4fetch`の`AwsClient`が該当する。
- **public API gap**: Cloudflareに対象機能が存在する一方、利用中の`cloudflare-workers-hs` revisionにサポート対象の型付き公開APIがない状態。利用アプリ内で迂回せず、別のlibrary拡張判断として扱う。
- **contract test**: Cloudflare実環境を必要とせず、公開APIと境界の入力・出力・失敗条件を固定するtest。
- **remote verification**: 実Cloudflare accountへdeployし、platform固有の挙動を確認する検証。

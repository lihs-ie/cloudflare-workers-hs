# Glossary

- **reactor**: WASI commandとは異なり、初期化後にexport関数を繰り返し呼び出すGHC WASM module。
- **JSFFI**: HaskellとJavaScriptの値・関数を接続するGHC WebAssembly foreign-function interface。
- **runtime package**: reactorのWASI初期化とCloudflare entrypoint接続を担う`@cloudflare-workers-hs/runtime`。
- **host testkit**: vanilla GHC上でCloudflare境界の純粋な契約を検証する補助library。
- **workerd**: Cloudflare Workers runtimeのオープンソース実装。WranglerとVitest poolの実行基盤。
- **NamedRoutes**: Servant APIをrecord-of-routesとして宣言し、対応するhandler recordへ接続する方式。
- **contract test**: Cloudflare実環境を必要とせず、公開APIと境界の入力・出力・失敗条件を固定するtest。
- **remote verification**: 実Cloudflare accountへdeployし、platform固有の挙動を確認する検証。

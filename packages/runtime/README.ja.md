# @cloudflare-workers-hs/runtime

[English](README.md)

GHC WASM reactorとCloudflare Workersを型付きで接続するESMパッケージです。WASIを初期化し、reactor exportを検証し、Worker・Durable Object・Workflowの入口を接続します。アプリケーションの処理はHaskell側に残します。

## 試運転中のインストール

まだnpmには公開していません。試運転中はGitのコミットを厳密に固定します。

```sh
pnpm add 'github:lihs-ie/cloudflare-workers-hs#COMMIT_SHA&path:/packages/runtime'
```

利用側で`pnpm pack`を実行する必要はありません。pnpmがGit依存を取得し、パッケージの`prepare`で`dist`を自動生成します。ランタイム更新を受け入れるときだけ`COMMIT_SHA`を変更してください。

pnpm 12はGit依存のbuild scriptを既定で拒否します。`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`に表示されたパッケージキー全体を`pnpm-workspace.yaml`の`allowBuilds`へ追加してください。この許可はSHA単位なので、固定SHAを更新するときは、このキーも更新してください。[旧リポジトリ](https://github.com/lihs-ie/cloudflare-workers-hs-runtime)の既存コミットも引き続き参照できます。

## Reactorの接続

```ts
import {
  bindExport,
  createReactor,
  decodeResponse,
  defineWorker,
} from '@cloudflare-workers-hs/runtime';
import makeImports from './application-jsffi.mjs';
import wasmModule from './application.wasm';

const reactor = await createReactor(wasmModule, makeImports, (exports) => ({
  fetch: bindExport<[request: Request, env: Env, context: ExecutionContext], Response>(
    exports,
    'fetch',
    decodeResponse,
  ),
}));

export default defineWorker({ fetch: reactor.fetch });
```

アプリケーションで`pnpm exec wrangler types`を実行し、生成された宣言を読み込んでください。そこにある`Env`と`ExecutionContext`が実際のCloudflare設定を表します。生成JSFFIとWASM importにもアプリケーション側で宣言を用意します。

`createReactor`はadapterを構築する前に`memory`、`_initialize`、任意のGHC scheduler exportを検証します。`bindExport`はexportが関数であることを確認し、解決した戻り値を毎回decodeします。標準の`decodeResponse`、`decodeString`、`decodeVoid`に加え、用途固有のdecoderでは`unknown`を検証してください。

## Platform helper

| API                    | 用途                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `defineWorker`         | fetch・queue・scheduled・tail handlerを検証してfreezeする。 |
| `initializeObject`     | Durable Object初期化を`blockConcurrencyWhile`へ登録する。   |
| `runObject`            | 必要に応じてネイティブ直列化を使ってobject操作を実行する。  |
| `decodeWorkflowResult` | Workflow結果の外形を検証する。                              |
| `unwrapWorkflowResult` | 成功値を返すか、native/non-retryable failureを維持する。    |

Durable ObjectとWorkflowのclassはCloudflareの基底classを明示的に継承します。これにより各入口でCloudflare生成型を利用でき、未検証の型アサーションを避けられます。

## 開発

リポジトリルートで、指定されているNodeとpnpmを使用します。

```sh
pnpm install --frozen-lockfile
pnpm --filter @cloudflare-workers-hs/runtime check
```

runtimeのソースを編集したら、サンプルを実行する前に `pnpm --filter @cloudflare-workers-hs/runtime build` で再ビルドしてください。

`pnpm check`はoxfmt、型付きOxlint、TypeScript 7、TSDoc、Vitest coverage、build、publint、Are the Types Wrongを実行します。runtime sourceのstatements・branches・functions・linesはすべて100%を必須とします。通常のnpm tarballが必要なリリース検証では`pnpm pack`を使います。

リポジトリルートで`pnpm test:package`を実行すると、checkoutしたコミットをワークスペース外からインストールして検証できます。

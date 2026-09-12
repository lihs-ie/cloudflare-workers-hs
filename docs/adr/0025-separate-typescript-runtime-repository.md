# TypeScript runtimeを独立リポジトリへ分離する

## ステータス

承認

## コンテキスト

ADR-0019はHaskellの4パッケージとnpm runtimeを同じリポジトリに配置した。しかし`packages/worker-runtime`はHaskell packageと見分けにくく、Node toolchainの更新周期と配布単位も異なる。

## 決定

`@cloudflare-workers-hs/runtime`を公開リポジトリ`lihs-ie/cloudflare-workers-hs-runtime`のルートpackageへ分離する。試運転中はnpmへ公開せず、利用側のpnpm catalogでGit commit SHAを固定する。pnpmの`allowBuilds`も同じSHAへ限定する。

Haskellの4パッケージ構成に関するADR-0019の決定は維持する。ADR-0019のnpm runtime配置に関する部分だけを本ADRで置き換える。

## 結果

runtimeはNode 24 LTS、pnpm 12、TypeScript 7、Vitest 5を独立して更新できる。生成された`dist`はGit管理せず、Git依存の`prepare`で生成する。利用者は`pack`を実行しないが、固定SHAのbuildを明示的に許可する必要がある。

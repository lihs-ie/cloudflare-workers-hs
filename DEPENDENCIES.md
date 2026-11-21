# 依存更新と脆弱性確認

2026-11-14にnpmの直接依存・間接依存と、ホスト/WASMのHaskell依存を確認しました。更新前の`pnpm audit`は38件（high 12、moderate 22、low 4）、更新後は0件です。これはその時点で監査データベースに登録されたnpm依存の結果です。

| 対象 | 採用版・方針 |
| --- | --- |
| Vitest / coverage-istanbul | 5.1.0で統一 |
| Cloudflare Vitest | 旧poolから公式の`@cloudflare/vitest-plugin` 1.8.2へ移行 |
| Wrangler / Miniflare | 4.162.0 / 5.20261113.0-beta（公式pluginと整合する依存） |
| esbuild / zod / yaml | 0.28.2 / 4.6.7 / 2.9.1 |
| c8 / TypeScript | 12.0.0 / 7.0.2 |
| Node型 | Node 24系列に合わせ24.19.2 |
| Node / pnpm | CI・Nix・Dockerで24.22.3 / 12.22.0を固定 |
| 間接依存の修正版 | Vite 8.2.4、source-map-js 1.2.2、glob 14.0.2、minimatch 11.0.1をoverride |
| Haskell index-state | host/WASMとも2026-11-14T00:00:00Z |
| Haskell修正版の下限 | aeson 2.2.5.1、text-iso8601 0.1.1.2、scientific 0.3.10.0、host warp 3.4.17 |

Cloudflare移行は[公式ガイド](https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/)、Vitestの実行環境要件は[移行ガイド](https://vitest.dev/guide/migration/)に従います。Cloudflareの3パッケージのみ、既存のrelease-age除外へ版を限定して追加しています。全パッケージの待機期間を無効にしていません。Miniflareのbeta版は公式の安定版plugin/Wranglerが要求する系列です。

間接依存のoverrideは親パッケージの追従まで残します。特にglob/minimatchはmajor更新を含むため、カバレッジのファイル選別とレポート生成の契約テストも確認します。再確認には`pnpm audit`と`pnpm why vite source-map-js glob minimatch`を使います。[pnpm auditの説明](https://pnpm.io/cli/audit)

Haskellでは[HSEC-2026-0007](https://haskell.github.io/security-advisories/advisory/HSEC-2026-0007.html)などの[公式アドバイザリ](https://haskell.github.io/security-advisories/)を参照し、scientificは0.3.9.0を修正版として採用せず0.3.10.0以上を要求します。HSEC-2023-0007（baseのNumeric.readFloat）とHSEC-2026-0006（Cabalのconfigure処理）には、この更新で解消したと報告できる修正版がありません。リポジトリ内にNumeric.readFloatの直接使用はありませんが、ツールチェーンを含めた脆弱性ゼロは保証しません。

解決されたHaskell依存はhost/WASMともaeson 2.2.5.1・text-iso8601 0.1.1.2・scientific 0.3.10.0、hostのwarpは3.4.21です。

`@cloudflare-workers-hs/runtime`の開発依存もルートのロックファイルとCI監査の対象です。外部プロジェクトでGit SHAを固定する手順は[runtimeのREADME](packages/runtime/README.ja.md#試運転中のインストール)に記載しています。

## CIの依存監査

PRで依存・ツールチェーン・ワークフローの設定が変わった場合と、定期実行時に、ロック済みのnpm依存を監査します。High/Criticalの検出時と、監査結果を取得できない場合はジョブが失敗します。ローカルでも `node scripts/testing/dependency-audit.mts` を使えます。

GitHub ActionsはコミットSHAで固定し、PRのジョブは読み取り権限で実行します。固定ロックでインストールし、公開後24時間の待機と個別にレビューした例外を適用します。ワークスペース内のruntimeは`prepare`でビルドします。外部Gitインストールの検証では、一時プロジェクトで検証対象のSHAにだけビルドを許可します。[Node.js 24.22.3](https://nodejs.org/en/blog/release/v24.22.3/) [pnpm 12.22.0](https://pnpm.io/blog/releases/12.22.0)

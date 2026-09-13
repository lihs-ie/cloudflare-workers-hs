# ADR-0027: 利用者向けライブラリの責務境界を定義する

- ステータス: 承認
- 日付: 2026-09-13
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0019](./0019-monorepo-package-layout.md), [ADR-0025](./0025-separate-typescript-runtime-repository.md)

## 背景と課題 (Context)

`cloudflare-workers-hs`はCloudflare Workers上でHaskellとServantを利用するためのライブラリ群である。一方、利用アプリから必要になった外部JavaScriptライブラリや業務処理まで「Binding」としてライブラリへ追加すると、Cloudflareが定義するBinding、Workers Runtime API、アプリケーション依存の境界が崩れる。

具体例として、CloudflareのR2ドキュメントは`aws4fetch`を通常のnpm packageとしてimportし、資格情報から`AwsClient`を構築している。これはCloudflareがWrangler経由で`env`へ供給するBindingではない。また、R2から取得したデータをImagesで変換してR2へ保存する処理は、個々のplatform operationではなくアプリケーションのworkflowである。

利用者と実装エージェントが同じ基準で責務を判断できるよう、提供範囲、対象外、情報源、および公開API不足時の扱いを定義する必要がある。

## 決定要因 (Decision Drivers)

- Cloudflareのプラットフォーム概念を正確に表現すること
- Servant利用者が既存のAPI型とエコシステムを活用できること
- 利用アプリの都合でライブラリの公開責務が際限なく広がらないこと
- 外部JavaScript依存を利用側で安全に統合できること
- ライブラリrevisionと利用ガイドの内容が一致すること

## 検討した選択肢 (Considered Options)

1. Cloudflare契約とServant統合に提供範囲を定め、アプリ固有機能を利用側へ置く
2. `env`へ置ける任意のJavaScript値をCustom Bindingとして受け入れる
3. 責務境界を定めず、要求ごとにライブラリへ機能を追加する

## 決定 (Decision)

採用する選択肢: **Cloudflare契約とServant統合に提供範囲を定め、アプリ固有機能を利用側へ置く**

提供対象を次のように区分する。

1. **Cloudflare Binding**: CloudflareまたはWranglerが設定し、platform resourceまたはcapabilityとしてWorkerの`env`へ供給するもの。このライブラリが実装済みのBindingには型付きHaskell APIを提供する。
2. **Workers Runtime API**: Request、Response、fetch、Cache、stream、socket、Web Crypto、event entrypointなど、BindingではないWorkersのruntime capability。このライブラリが実装済みのAPIには型付きHaskell APIを提供する。
3. **Servant統合**: Workers向けServer interpreter、fetchベースClient、Cloudflare Access認証、およびWorkers固有combinatorを提供する。新規利用例は`NamedRoutes`を標準とするが、既存のServant API型とServantが提供する選択肢を制限しない。
4. **WASM runtime連携**: 別配布の`@cloudflare-workers-hs/runtime`によってGHC WASI reactorとWorker entrypointを接続する。

次は提供対象外とする。

- npm package、外部JavaScript SDK、外部SaaS clientの個別wrapper
- Cloudflare control-plane API、resource provisioning、token発行、DNS、IaC、deployment policy
- APIの業務的意味、domain model、認可policy、schema、migration、key、message format
- 複数のBindingやRuntime APIを束ねるapplication workflow、retry、idempotency、compensation
- アプリのresource topology、Wrangler環境値、route、cron、secret内容
- 任意のJavaScript objectをCloudflare Bindingとして扱う一般機構

外部JavaScript依存をHaskellから利用する必要がある場合は、利用アプリが所有する狭いJSFFI/TypeScript adapterで統合する。raw `JSVal`をdomain/application logicへ漏らさず、値変換と失敗を境界で明示する。

Cloudflare概念の正本は現在のCloudflare公式ドキュメントとする。このライブラリが実装する機能の正本は、利用するGit revisionのサポート対象公開API、README、およびproduction exampleとする。Cloudflare公式に存在する機能でも、当該revisionに公開APIがなければ未対応である。

## 結果 (Consequences)

### 良い結果 (Positive)

- Cloudflare Binding、Runtime API、アプリ依存を混同せず説明できる。
- 利用側のworkflowとライブラリのplatform interfaceが分離される。
- 外部JS依存のために汎用Binding surfaceを追加する必要がない。
- Agent Skillをlibrary revisionとともに配布し、判断と検証を再現できる。

### 悪い結果・トレードオフ (Negative)

- 公開APIが未対応の場合、利用側の作業を止めて別の拡張判断が必要になる。
- 外部JS依存をHaskellから呼ぶアプリは、独自の狭いFFI境界と実WASMテストを保守する。
- 提供機能とSkill referenceをreleaseごとに同期する必要がある。

### 中立・フォローアップ (Neutral / Follow-up)

- `Internal` moduleのCabal visibility整理はパッケージ公開API設計の別課題として扱い、本ADRの利用ガイドには含めない。
- 利用者向けSkillは`skills/use-cloudflare-workers-hs`から`gh skill`で配布する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 責務境界を定める

- 利点: library surfaceがCloudflareとServantの契約に対応し、利用側の変更から独立する。
- 欠点: 利用側とライブラリ側のIssueを分けて設計する手間が生じる。

### 任意JavaScript値をCustom Bindingとして受け入れる

- 利点: JavaScript objectを手早く`BindingEnv`へ渡せる。
- 欠点: Cloudflare Bindingとアプリの依存注入を混同し、型tagがobjectの実際のshapeやcapabilityを保証しない。

### 境界を定めない

- 利点: 個別要求へ局所的に対応しやすい。
- 欠点: 公開APIの意味と保守責任が要求ごとに拡大する。

## 遵守事項 (Compliance)

- [ ] READMEは提供範囲、対象外、およびSkillの導入方法を案内する。
- [ ] 用語集はBinding、Runtime API、Application dependencyを区別する。
- [ ] 利用者向けSkillは同じlibrary tagまたはcommitへpinできる形で配布する。
- [ ] Skillは公開API不足時に利用側でライブラリを拡張せず、別Issueとして報告する。
- [ ] platform boundaryを含む利用例はnative testだけで完了せず、実WASMとWrangler/workerdで検証する。

## 参考資料 (References)

- Cloudflare Workers — Bindings: https://developers.cloudflare.com/workers/runtime-apis/bindings/
- Cloudflare R2 — aws4fetch: https://developers.cloudflare.com/r2/examples/aws/aws4fetch/
- GitHub CLI — `gh skill install`: https://cli.github.com/manual/gh_skill_install

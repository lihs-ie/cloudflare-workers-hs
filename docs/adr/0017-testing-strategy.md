# ADR-0017: テスト戦略を vanilla GHC 単体・wasm 統合・servant 互換性検証で定義する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0001](./0001-ghc-native-wasm-backend.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md), [調査メモ](../research/feasibility-servant-on-cloudflare-workers.md)

## 背景と課題 (Context)

本ライブラリのコードは `wasm32-wasi` ターゲットを前提とし、最終的な実行環境は workerd である。
このため二重の制約がテストにかかる。

1. **stock GHC では実行できない。** コンパイルツールチェーンは GHC ネイティブ WebAssembly
   バックエンド（[ADR-0001](./0001-ghc-native-wasm-backend.md)）一択であり、`wasm32-wasi` 用にビルドした
   成果物は通常の `x86_64`/`aarch64` 上の stock GHC では走らない。一方で WASM ビルドは時間・リソースを
   要する（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）ため、純粋ロジックの検証まで毎回 WASM 経由で
   行うのは遅い。
2. **実環境は workerd である。** JSFFI 境界・reactor 初期化（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）・
   `ReadableStream` の素通し（[ADR-0007](./0007-streaming-readablestream.md)）・`env` バインディング
   （[ADR-0008](./0008-cloudflare-platform-bindings.md)）は、ホスト JS ランタイム上でしか観測できない
   挙動を含む。stock GHC 上の純粋テストだけでは、これらの統合的な正しさを保証できない。

加えて、サーバ解釈系は `servant-server` をフォークも依存もせず自前実装する方針
（[ADR-0006](./0006-servant-execution-engine.md)）であるため、同 ADR が明記した
「**`servant-server` の挙動（コンテンツネゴシエーション、エラー整形など）と微妙に異なるリスク**」を
継続的に検出する仕組みが要る。ADR-0006 はこの対応を本 ADR の互換性テストの検証対象として
前方参照している。

したがって、「stock GHC で動かない」「workerd で動かす」「`servant-server` 互換を保つ」という
三つの制約を同時に満たすため、意図的に層を分けたテスト戦略を定義する必要がある。

## 決定要因 (Decision Drivers)

- 純粋ロジック（ルーティング・引数抽出・コンテンツネゴシエーション）を **stock GHC** で高速に
  検証でき、毎コミットで回せること
- JSFFI / reactor / workerd 固有の挙動を **実 `.wasm` モジュール**で検証できること
- 自前解釈系が `servant-server` の文書化された挙動（状態コード意味論・コンテンツネゴシエーション）と
  一致することを検証できること（[ADR-0006](./0006-servant-execution-engine.md) の互換性リスクへの対処）
- テストピラミッドに沿い、低レイヤーで検証できるものを上位に持ち上げないこと
- CI（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）のツールチェーン固定・WASM ビルドに統合できること

## 検討した選択肢 (Considered Options)

1. **層別戦略: vanilla GHC 単体テスト + wasm 統合テスト + `servant-server` 互換性テスト**
2. **wasm 統合テストのみ**（すべてを実 `.wasm` + workerd 上で検証する）
3. **vanilla GHC 単体テストのみ**（純粋ロジックだけを stock GHC で検証する）

## 決定 (Decision)

採用する選択肢: **選択肢 1**

テストを三層に分け、テストピラミッド（多数の純粋単体・少数の統合・最小限の end-to-end）に沿って構成する。

### 1. 純粋単体テスト（vanilla GHC）

自前のサーバ解釈系（[ADR-0006](./0006-servant-execution-engine.md) の `HasServer` 相当: ルーティング・
引数抽出・コンテンツネゴシエーション・エラー応答）のうち、JSFFI に依存しない純粋ロジックを
**stock GHC** でコンパイル・実行する。WASM 向けコードを stock GHC で型検査・実行可能にするため、
`ghc-wasm-compat` 相当の互換シムを用いる（調査メモのとおり `ghc-wasm-compat` は vanilla GHC で
WASM ターゲット向けコードを型検査可能にする）。JSFFI の `foreign import javascript` 境界は、
純粋ロジックがその裏側の型のみに依存するよう設計し、テストでは差し替え可能な抽象境界として扱う。
これらは高速で、**毎コミット**で CI 実行する（テストファイルは `*.test`/`#[cfg(test)]` ではなく、
Haskell の慣行に従い hspec/tasty 等のスペックとして配置する）。

### 2. 統合テスト（実 wasm reactor モジュール）

実際にビルドした `.wasm` reactor モジュールを次のいずれか（または両方）で実行し、JSFFI 境界・
reactor 初期化・`Request`/`Response` 変換・ストリーミング・`env` バインディングを検証する。

- **Node.js + post-link ハーネス**: post-linker（`post-link.mjs`、[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）が
  生成した JSFFI グルーを用い、Node.js 上で `_initialize` 後に `fetch` export を呼ぶ。JSFFI 単体の
  健全性確認に向く。
- **workerd 上の実行**: `wrangler dev` / Miniflare、あるいは vitest の Workers プール
  （`@cloudflare/vitest-pool-workers`）でテストを Workers ランタイム内で走らせる。Miniflare は
  ローカルで workerd 互換の挙動を再現するため、実デプロイに近い条件で `fetch` ハンドラの統合挙動を
  検証できる。

統合テストは WASM ビルドを要するため**相対的に少数**に絞り、純粋単体で検証できないもの（JSFFI/
reactor/workerd 固有挙動）のみを対象とする。

### 3. `servant-server` 互換性テスト（golden / プロパティベース）

自前解釈系が `servant-server` の文書化された挙動に一致することを検証する。

- **エラーモデル**（[ADR-0006](./0006-servant-execution-engine.md) で確定）: ルート不一致 **404**、
  メソッド不一致 **405**、`Accept` 不適合 **406**、`Content-Type` 不適合 **415**、本文デコード/検証
  失敗 **400** を golden ケースとして固定し、状態コードとエラー本文（JSON エンベロープ／plain text
  フォールバック）を突き合わせる。
- **ルーティングとコンテンツネゴシエーション**: 同一の Servant API 型に対し、入力リクエスト集合
  （パス・メソッド・`Accept`/`Content-Type`・クエリ・本文）を**プロパティベース**で生成し、自前解釈系の
  決定（どのハンドラへ、どの状態コードで）が `servant-server` の仕様と一致するかを検査する。

互換性テストは純粋ロジックを対象とするため**第 1 層（vanilla GHC）上で実行**でき、毎コミットで回せる。

### CI への統合

上記をすべて CI（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）に載せる。ツールチェーン（GHC wasm /
stock GHC / `cabal` / `ghc-wasm-meta`）はロック・固定し、(a) vanilla GHC 単体＋互換性テストを毎コミットで、
(b) WASM ビルド＋統合テストを CI のビルドジョブに続けて実行する。

## 結果 (Consequences)

### 良い結果 (Positive)

- 純粋ロジックを stock GHC で高速検証でき、開発者は WASM ビルドを待たずにフィードバックを得られる。
- JSFFI/reactor/workerd 固有の挙動は実 `.wasm` 上で検証され、stock GHC では拾えない統合バグを捕捉できる。
- `servant-server` 互換性が golden/プロパティで継続検証され、[ADR-0006](./0006-servant-execution-engine.md) が
  挙げた「微妙に異なるリスク」を回帰として検出できる。
- テストピラミッドに沿うため、遅い WASM/workerd テストの本数を抑えつつ網羅性を確保できる。

### 悪い結果・トレードオフ (Negative)

- `ghc-wasm-compat` 相当のシムを stock GHC ビルドと WASM ビルドの双方で整合させる保守が要る。
  シムと実 JSFFI の差異が「単体では緑だが統合で赤」を生む可能性がある。
- `servant-server` を参照実装として扱うが、依存はしない（[ADR-0006](./0006-servant-execution-engine.md)）。
  互換性の基準は同ライブラリの**文書化された挙動**に基づき、振る舞いの差は golden の更新で明示管理する。
- workerd 統合テスト基盤（Miniflare / `@cloudflare/vitest-pool-workers`）と WASM ビルドを CI で
  常時動かすため、CI 時間とキャッシュ設計の負担が増える。

### 中立・フォローアップ (Neutral / Follow-up)

- 統合テストを Node.js ハーネスと workerd（Miniflare）のどちらに寄せるか、各々の責務分担を実装段階で確定する。
- WebSocket / Durable Objects（[ADR-0010](./0010-websockets-durable-objects.md)）の end-to-end 検証は
  最小限の Miniflare シナリオとして別途設計する（本 ADR の対象は主にルーティング・HTTP 経路）。
- プロパティベース検証で用いる API 型の生成戦略（組み合わせ子の網羅範囲）を [ADR-0006](./0006-servant-execution-engine.md) の
  MVP 組み合わせ子に合わせて定義する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 層別戦略（vanilla 単体 + wasm 統合 + 互換性検証）

- 利点: 純粋ロジックを高速に毎コミット検証しつつ、JSFFI/workerd 固有挙動と `servant-server` 互換性も
  個別に担保できる。テストピラミッドに整合し、遅いテストを最小化できる。
- 欠点: シム（`ghc-wasm-compat` 相当）の整合保守と、三層を支える CI 構成の初期コスト。

### wasm 統合テストのみ

- 利点: 実環境に最も近く、JSFFI/reactor/workerd の挙動をそのまま検証できる。
- 欠点: 純粋ロジックの検証まで毎回 WASM ビルド＋workerd 起動を要し**遅い**。ロジックの不具合を
  実行環境の問題から切り分けにくく、フィードバックループが長い。テストピラミッドに反する。

### vanilla GHC 単体テストのみ

- 利点: 高速で、毎コミットに容易に載る。
- 欠点: JSFFI 境界・reactor 初期化・`ReadableStream`・`env` バインディングなど **実 WASM/workerd でしか
  現れない挙動を取りこぼす**。本ライブラリの最終実行環境を検証できず、デプロイ前の保証として不十分。

## 遵守事項 (Compliance)

- [ ] 純粋な解釈系ロジック（ルーティング・引数抽出・コンテンツネゴシエーション）の単体テストを
      stock GHC でビルド・実行し、毎コミットの CI で回す。
- [ ] vanilla GHC ビルドは `ghc-wasm-compat` 相当の互換シムを用い、WASM 向けコードを stock GHC で
      型検査・実行できる状態を維持する。
- [ ] 実 `.wasm` reactor モジュールを Node.js ハーネスおよび／または workerd（`wrangler dev` /
      Miniflare / `@cloudflare/vitest-pool-workers`）で実行する統合テストを用意する。
- [ ] [ADR-0006](./0006-servant-execution-engine.md) のエラーモデル（400/404/405/406/415）を golden ケースとして固定し、
      状態コードとエラー本文を `servant-server` の文書化挙動と突き合わせる互換性テストを持つ。
- [ ] ルーティング／コンテンツネゴシエーションをプロパティベースで `servant-server` 仕様と照合する。
- [ ] テスト用ツールチェーン（GHC wasm / stock GHC / `cabal` / `ghc-wasm-meta`）のバージョンを
      [ADR-0015](./0015-build-deploy-ci-pipeline.md) と同様に固定し、CI で WASM ビルド＋テストを実行する。

## 参考資料 (References)

- GHC User's Guide — WebAssembly backend（JSFFI / reactor / `wasm32-wasi`）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- konn/ghc-wasm-earthly（`ghc-wasm-compat` で vanilla GHC でも型検査可能・設計参照のみ）: https://github.com/konn/ghc-wasm-earthly
- Cloudflare Workers — Testing（概要）: https://developers.cloudflare.com/workers/testing/
- Cloudflare Workers — Vitest integration（`@cloudflare/vitest-pool-workers` / Miniflare でランタイム内実行）: https://developers.cloudflare.com/workers/testing/vitest-integration/
- Cloudflare Workers — Miniflare: https://developers.cloudflare.com/workers/testing/miniflare/
- Haskell Discourse — Serverless Haskell with GHC WASM + JSFFI on Cloudflare Workers: https://discourse.haskell.org/t/serverless-haskell-with-ghc-wasm-jsffi-cloudflare-workers/9784

## 追補 (2026-07-22): vanilla GHC ビルドの互換手段変更 + conformance oracle の実装

- ステータス: 承認（追補）
- 日付: 2026-07-22
- 決定者: lihs

### 決定 1: vanilla GHC 互換手段の変更

本文「1. 純粋単体テスト（vanilla GHC）」節が前提としていた `ghc-wasm-compat` 相当の互換シムは
用いない。[ADR-0019](./0019-monorepo-package-layout.md) 追補で確定した方式（cabal `if os(wasi)`
条件 + ソース内 CPP `#if defined(wasm32_HOST_ARCH)`）に置き換える。詳細は
[ADR-0019](./0019-monorepo-package-layout.md) 追補「二重ビルド方式と FFI 隔離範囲の確定」を参照する
（本 ADR の記述はこれに従属する）。

### 決定 2: tier3 conformance の実装形態確定

本文「3. `servant-server` 互換性テスト（golden / プロパティベース）」の実装形態を次のとおり確定する。

- 実 `servant-server` 0.20.3.0 + `Network.Wai.Test` を **dev-only package
  `conformance-oracle`**（出荷 4 パッケージ外・wasm ビルド対象外）で **host 実行**し、
  golden（50 ケース）を生成・commit する。
- 出荷側の test-suite は `servant-server` **非依存**のまま、commit 済みの golden とバイト比較する。
- 生成は**決定論的**（時刻・乱数を使用しない）。再生成は `just` recipe で行う。

この形態により、[ADR-0006](./0006-servant-execution-engine.md) の「`servant-server` に（テストを
含め）依存しない」という出荷側の制約と、conformance の oracle として実 `servant-server` の挙動を
直接参照したいという要求を、パッケージ境界で両立させる。conformance 境界（比較対象を status /
Content-Type / 成功 body に限り、エラー body を比較から除外すること）は
[ADR-0006](./0006-servant-execution-engine.md) 追補で確定した内容に従う。

### 遵守事項への影響（本文 override）

本文「遵守事項 (Compliance)」の以下の項目は、本追補により内容を変更する（本文自体は書き換えない）。

- 「vanilla GHC ビルドは `ghc-wasm-compat` 相当の互換シムを用い、WASM 向けコードを stock GHC で
  型検査・実行できる状態を維持する。」
  → **追補により [ADR-0019](./0019-monorepo-package-layout.md) 追補の CPP 方式に変更**。
  `ghc-wasm-compat` への依存は追加しない。
- 「[ADR-0006](./0006-servant-execution-engine.md) のエラーモデル（400/404/405/406/415）を golden
  ケースとして固定し、状態コードとエラー本文を `servant-server` の文書化挙動と突き合わせる互換性
  テストを持つ。」
  → **追補により比較対象を明確化**: status（常時）+ Content-Type（charset 込み）+ 成功（2xx）body。
  エラー body は比較除外（[ADR-0006](./0006-servant-execution-engine.md) 追補）。golden 50 ケースは
  dev-only package `conformance-oracle` の host 実行で生成・commit する。

### 参考資料（追補分）

- [ADR-0019](./0019-monorepo-package-layout.md) 追補（二重ビルド方式と FFI 隔離範囲の確定）
- [ADR-0006](./0006-servant-execution-engine.md) 追補（実装確定事項 — 移植方式・conformance 境界・documented extensions）
- servant-server (Hackage, 0.20.3.0)（conformance oracle の参照実装）: https://hackage.haskell.org/package/servant-server-0.20.3.0
- wai-extra（`Network.Wai.Test`）: https://hackage.haskell.org/package/wai-extra

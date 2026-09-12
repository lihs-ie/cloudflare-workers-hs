# ADR-0008: Cloudflare プラットフォームバインディングを env 経由でハンドラ文脈に供給する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)

## 背景と課題 (Context)

実運用の Worker は `fetch(request, env, ctx)` の `env` 経由で各種リソースに触れる。代表的なものは
**KV**（キーバリュー）、**R2**（オブジェクトストレージ）、**D1**（SQLite 系 DB）、
**Durable Objects**（強整合な常駐オブジェクト）、**Queues**、**Service Bindings**（Worker 間 RPC）、
**Secrets/Vars**（機密・環境変数）、**Cache API** である。Servant ハンドラからこれらを型付きで安全に
使えるようにすることが、実運用に「不自由なく」到達する条件となる。

本プロジェクトは自前実装方針のため、これらのバインディングは [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) の
JSFFI バインディング層の上に**自前で実装**する。

## 決定要因 (Decision Drivers)

- `env` の各リソースを型付きで宣言・取得できること（誤った binding 名・型の検出）
- Servant ハンドラ文脈へ `env`/`ctx` を注入できること（[ADR-0006](./0006-servant-execution-engine.md) の解釈系と統合）
- 非同期 API（KV/R2/D1 はいずれも Promise）を async JSFFI で扱えること
- 段階的に対応バインディングを増やせる拡張性

## 検討した選択肢 (Considered Options)

1. **型付き `Env` を宣言し、`env`/`ctx` を Servant ハンドラ文脈へ注入する自前バインディング群**
2. ハンドラ内で都度 `env` を動的に触る（共通の型付き層を設けない）
3. 外部バインディングライブラリ（`ghc-wasm-earthly` の D1/R2/KV 等）へ依存する

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- 利用するバインディングを型で宣言する `Env` 表現を用意し、`env` から名前で取り出すアクセサを
  JSFFI で実装する。各リソース（KV/R2/D1/Durable Objects/Queues/Service Bindings/Secrets/Cache）に
  対応する newtype と型付き操作（KV: get/put/delete/list、R2: get/put/head/delete、
  D1: prepare/bind/all/run、Queues: send/sendBatch、Service Bindings: fetch/RPC）を提供する。
- `env`/`ctx` は fetch エントリ（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）から
  サーバ解釈系（[ADR-0006](./0006-servant-execution-engine.md)）のハンドラ文脈へ注入する。
  Servant の文脈（`Context`/`ReaderT` 的注入、または専用組み合わせ子）として表現する。
- 非同期操作はすべて async JSFFI（Promise/`await`）で表現する。
- 実装は段階的とし、**MVP は KV / R2 / D1 / Secrets / Service Bindings** を優先、
  Durable Objects（[ADR-0010](./0010-websockets-durable-objects.md) と連携）・Queues・Cache は後続で拡充する。
- **設定・シークレットの供給と起動時検証**: 機密は `wrangler secret`、非機密は Vars で供給し、環境（dev/staging/prod）は `wrangler` の environments で分離、ローカルは `.dev.vars` を用いる。必須設定（Access の `aud`・チームドメイン・JWKS URL（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）、ログレベル（[ADR-0013](./0013-observability.md)）等）は **型付きの「必須設定」面**にまとめ、**isolate 初期化時に検証し、欠落/不正なら fail-fast** する。

## 結果 (Consequences)

### 良い結果 (Positive)

- ハンドラから Cloudflare リソースを型安全に使え、実運用に必要なデータ層が揃う。
- `env` 注入が解釈系と統合され、Servant の宣言的記述の中で binding を扱える。

### 悪い結果・トレードオフ (Negative)

- 各バインディング API を逐次実装・追従する工数（Cloudflare 側 API 変更への保守）。
- バインディングを増やすほどバンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）が増える。使用分のみを含める工夫が要る。

### 中立・フォローアップ (Neutral / Follow-up)

- `wrangler` の binding 宣言（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）と Haskell 側の型宣言の
  整合を検証する仕組み（命名・存在チェック）を検討する。
- Durable Objects のクラス定義（JS 側 export）と Haskell 側の対応は [ADR-0010](./0010-websockets-durable-objects.md) で扱う。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 型付き `Env` + 文脈注入（自前）

- 利点: 型安全・解釈系統合・段階拡張。方針と整合。
- 欠点: 実装/追従工数、サイズ増。

### 都度動的アクセス

- 利点: 前準備が最小。
- 欠点: 型安全性が低く、binding 名/型の誤りを実行時まで検出できない。

### 外部バインディング依存

- 利点: 初期工数が小さい。
- 欠点: 自前実装方針に反する。作者が R2/Cache 周りを「推奨しない」とする等、脆さがある。

## 遵守事項 (Compliance)

- [ ] `env` アクセスは型付きバインディング層を経由し、ハンドラに生 JSFFI を散在させない。
- [ ] 非同期リソース操作は async JSFFI として型に反映する。
- [ ] 外部の Cloudflare バインディングライブラリへ依存しない。
- [ ] 必須設定は起動時に検証し、欠落/不正時は明確に失敗させる（実行時まで遅延させない）。

## 参考資料 (References)

- Haskell Discourse — Blog system on Cloudflare Workers（D1/R2/KV/Service Bindings の自前バインディング）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- GHC User's Guide — WebAssembly backend（JSFFI/async）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- konn/ghc-wasm-earthly（設計参照のみ）: https://github.com/konn/ghc-wasm-earthly

## 追補 (2026-07-23): KV/D1/R2 実装で確定した設計

- ステータス: 承認（追補）
- 日付: 2026-07-23
- 決定者: lihs

Phase A theme A3（`getBinding` 実配線 + KV/D1/R2 実 I/O、実機検証済み）で確定した設計を記録する。本文
「決定 (Decision)」節が示した方針（型付き `Env`、段階的拡張、必須設定の起動時検証）を、以下のとおり
実装レベルで具体化する。本文自体は書き換えない。

### 決定 1: binding 配線 — 型レベル fold + env 構築時の全数検証

`bindings :: [(Symbol, Type)]` を畳む型クラス `BuildBindingEnv`（`Cloudflare.Workers.Internal.FFI.BindingEnv`）
が、宣言済みの各 binding 名を実行時の `env` map に対して型クラス `FromBindingJSVal` 経由で変換する。
`Cloudflare.Workers.Env.getBinding` 本体（`Map Text Dynamic` に対する pure lookup）は変更しない。

宣言済み binding のうち実 `env` に存在しないものは、**`BindingEnv` 構築時（per-request、ハンドラ実行前）
に全数検査**され、`BindingMissingError`（`Control.Exception.Exception` インスタンス、typed）が投げられる。
この例外は `mkFetchHandler` の既存 top-level `try @SomeException` に捕捉され、他の未捕捉例外と同じ固定
500 応答 + `tailLog` に落ちる。専用のエラー経路は設けない。

本 ADR「必須設定・シークレットの供給と起動時検証」節が言う「起動時検証」は、reactor モデル
（[ADR-0002](./0002-wasi-reactor-workerd-integration.md)）では isolate 起動と初回 `fetch` が実質同時で
あるため、**per-request の env 構築を「起動時」の実装**と解釈する。

### 決定 2: handle 型は CPP 二分岐（newtype JSVal / STUB）

`KV` / `D1` / `D1PreparedStatement` / `R2Bucket` はいずれも次の形を採る。

```haskell
#if defined(wasm32_HOST_ARCH)
newtype X = X JSVal
#else
data X = XSTUB
#endif
```

`Cloudflare.Workers.Reactor.Ctx` が既に確立した CPP 分岐パターンを踏襲する。構築子は `X (..)` として
パッケージ全体へ公開する — `Internal.FFI.BindingEnv` の `FromBindingJSVal` インスタンス本体
（`fromBindingJSVal = pure . X`）が生の `JSVal` を wrap するために必要（[ADR-0019](./0019-monorepo-package-layout.md)
追補の「単一 `src` ツリー + `wasm32_HOST_ARCH` CPP」方式に従う）。

### 決定 3: options 引数は incremental object build に統一

KV/D1/R2 の options 引数（`KVPutOptions`、`KVNamespace#list` options、R2 の `httpMetadata`・
`customMetadata` 等）は、`unsafe "({})"` で空オブジェクトを作り、値が存在するフィールドのみ個別
`unsafe` import で assign するイディオムに統一する。ネストしたオブジェクト（R2 の `httpMetadata`
サブオブジェクト等）は二段で組み立てる。

### 決定 4: KV/R2 の list 結果は実 API の判別共用体に忠実

`KVListResult { kvListResultKeys :: [KVListKey], kvListResultListComplete :: Bool, kvListResultCursor :: Maybe Text }`
と `R2ListResult { r2ListResultObjects :: [R2ObjectMeta], r2ListResultTruncated :: Bool, r2ListResultCursor :: Maybe Text, r2ListResultDelimitedPrefixes :: [Text] }`
は、いずれもページネーション（`cursor` + 完了フラグの対）を持つ実 API の形を忠実に再現する。旧
`IO [Text]`（フラットなキー名リスト）は採らない。

`KVListKey.kvListKeyMetadata :: Maybe Text` は raw JSON の `Text` のまま保持し、デコードしない。
`cloudflare-workers`（基盤パッケージ、[ADR-0019](./0019-monorepo-package-layout.md)）は `aeson` に
依存しない servant-free leaf であり、この 1 フィールドのためだけに依存を追加しない。

### 決定 5: D1 row decode は JS 側構造 walk（aeson 不採用）

`D1Value`（`D1Null` / `D1Integer` / `D1Real` / `D1Text` / `D1Blob` の 5 構築子）は SQLite の列 affinity
（`NULL`/`INTEGER`/`REAL`/`TEXT`/`BLOB`）と 1:1 対応する。行のデコードは JS 側で `typeof`/
`Number.isInteger`/`instanceof` による構造 walk を行い、`aeson` は使わない。理由は (a) 依存最小、
(b) JSON を経由すると SQLite の型情報（INTEGER/REAL/BLOB の区別）が失われるため。

### 決定 6: D1 エラーは throw、`success` はエラー検出手段ではない

`d1Run`/`d1Batch`/`d1Exec` は失敗時に例外を throw する。**`D1Result`/`D1RunResult` の
`d1ResultSuccess`/`d1RunResultSuccess` は happy path で常に `True` であり、エラー検出の手段として
扱ってはならない。** 分類は実採取したエラーメッセージの substring マッチで行う
（`classifyD1RawErrorMessage`）: `"UNIQUE constraint"`/`"FOREIGN KEY constraint"`/
`"CHECK constraint"`/`"NOT NULL constraint"`/`"SQLITE_CONSTRAINT"` → `D1ConstraintViolation`、
`"syntax error"`/`"SQLITE_ERROR"` → `D1SyntaxError`、いずれにも一致しなければ `D1UnknownError`
（暫定の安全側フォールバックであり不具合ではない）。

### 決定 7: R2 get は 3 値、body は reader closure + 生 stream handle の両建て

`r2Get :: R2Bucket -> Text -> Maybe R2Range -> Maybe R2Condition -> IO R2GetResult` は
`R2GetNotFound` / `R2GetPreconditionFailed R2ObjectMeta`（`onlyIf` 不一致、body 無し）/
`R2GetSuccess R2Object` の 3 値を返す。`R2Object` の body は学習者/ハンドラ向けには
`r2ObjectBodyReader :: Int -> IO (Either ReadableStreamReadError LazyByteString.ByteString)`
（byte-limit reader closure、[ADR-0007](./0007-streaming-readablestream.md) の 413 方針に従う）として
公開する。内部の `Internal.FFI.*` 層では実結果の生 `ReadableStream`（`JSVal`）handle をそのまま受け渡し、
`Cloudflare.Workers.Streaming.readableStreamFromJSVal` 経由で reader closure へ wrap する
（closure 抽象と生 handle 受け渡しの両建て）。

### 決定 8: timestamp・サイズは `time` 非依存のエポック数値、**絶対値は `Integer` / 相対値・件数は `Int`**、単位はフィールド毎

timestamp・サイズ系フィールドはいずれも `time` パッケージに依存せずエポック数値で表現するが、
**単位はフィールドごとに異なり**、かつ **絶対時刻・サイズは `Integer`、相対値・件数は `Int` のまま**
とする（当初 `Int` 統一としていたが、spike 実機検証で以下の理由により訂正 — 詳細根拠は
`~/.pschool/spikes/cloudflare-workers-hs-build/_phase_b/divergence-notes.md` の
「Reviewer iter1 fix #1(c) resolution」節）。

**根拠**: `wasm32-wasi` ターゲットの GHC は `Int` が 32-bit（`maxBound :: Int == 2147483647`）。
エポック*ミリ秒*値は 2026 年時点で既に 2^31 を大きく超えており（`~1.7-1.8 * 10^12`）、`Int` 型の
フィールドを実機（`wasm32-wasi-cabal build` + 実 workerd）でクロスすると値が silently wrap する
（実測: `R2ObjectMeta.r2ObjectMetaUploaded` が `-1951017316` のような負値になる）。R2 オブジェクトの
サイズ（最大 5 TiB）や KV の `expiration`（エポック秒、2038 年問題）も同じ理由で `Int` に収まらない
値になり得る。`D1Meta.d1MetaLastRowId :: Maybe Integer` が既にこのクラスの問題へ `Integer` で
対処済み — という認識だったが、reviewer iter2 で誤りと判明（下記「★訂正」参照）。同じ扱いを
R2/KV の該当フィールドへも適用する。

- **絶対時刻・サイズ（`Integer`）**
  - `KVPutOptions.kvPutOptionsExpiration :: Maybe Integer` — エポック**秒**（実 `KVNamespace#put` の
    `expiration`）
  - `KVListKey.kvListKeyExpiration :: Maybe Integer` — 上記を `list()` が echo back する値
  - `R2ObjectMeta.r2ObjectMetaUploaded :: Integer` — エポック**ミリ秒**（実 `R2Object#uploaded` は
    JS `Date`、`.getTime()` 経由）
  - `R2ObjectMeta.r2ObjectMetaSize :: Integer` — バイト数（R2 オブジェクトは最大 5 TiB）
  - `R2Condition` の `uploadedBefore`/`uploadedAfter :: Maybe Integer` — `r2ObjectMetaUploaded` と
    同単位（エポックミリ秒）
  - `D1Meta.d1MetaLastRowId :: Maybe Integer` — D1 の `INTEGER PRIMARY KEY` rowid
  - `D1Meta.d1MetaRowsRead`/`d1MetaRowsWritten :: Maybe Integer` — クエリプラン累積のビリング用件数
    カウンタ（★訂正、下記参照。`d1MetaChanges :: Maybe Int` は文単位の影響行数のため対象外のまま）
- **相対値・件数（`Int` のまま）**
  - `KVPutOptions.kvPutOptionsExpirationTtl :: Maybe Int` — 現在時刻からの相対秒数
  - `R2Range` の offset/length/suffix、`kvList`/`r2List` の `limit` — バイトオフセット・件数
  - `D1Meta.d1MetaChanges :: Maybe Int` — 文単位の影響行数（累積カウンタではない）

各フィールドの単位（秒 or ミリ秒）は混同禁止であることを Haddock に明記する運用は変更しない。
FFI 境界そのものは実装レベルでは `Double`（GHC wasm JSFFI の JS `number` 直接 marshalling 型、
2^53 まで正確）を経由する — 読み取りは `Double` で受けてから `round` で `Integer` へ、書き込みは
`fromInteger` で `Double` へ変換してから渡す。

**★訂正（reviewer iter2、2026-07-23）**: 上記「根拠」で「`D1Meta.d1MetaLastRowId :: Maybe Integer`
が既にこのクラスの問題へ対処済み」としていたのは誤りだった。`D1Meta` の Haskell 側フィールド型は
確かに `Maybe Integer` だったが、その値を読む `Internal.FFI.D1.jsD1MetaLastRowIdField` 自身の FFI
境界の戻り値型は `JSVal -> IO Int` のままで、`Integer` への変換が起きる *前* に 32-bit `Int` の wrap
がすでに発生していた（実測: `id = 3000000000` の INSERT で `meta.last_row_id` が `-1294967296`、
`3000000000` の signed-32-bit wrap と一致）。同じ FFI 境界の型不備が `rows_read`/`rows_written`
（`jsD1MetaRowsReadField`/`jsD1MetaRowsWrittenField`、いずれも旧 `IO Int`）にもあったため、3 フィー
ルドとも `IO Double`（`round` で `Integer` へ）へ修正 — 詳細根拠は
`~/.pschool/spikes/cloudflare-workers-hs-build/_phase_b/divergence-notes.md` の
「Reviewer iter2 fix」節。**教訓**: この種の overflow 監査では Haskell 側フィールド型 (`Integer`) だ
けでは不十分で、`foreign import` 自身が宣言する境界の型を直接確認する必要がある。

### 実測で確定した挙動（記録）

- R2 のバケット名は **ハイフンのみ許可、アンダースコア不可**（`wrangler.toml` の
  `[[r2_buckets]].bucket_name` が拒否する）。KV の `id`/D1 の `database_name` はアンダースコア許容で
  あり、R2 のみ非対称。
- R2 の `onlyIf` の `etagMatches`/`etagDoesNotMatch` は **bare（unquote）形式必須**。quoted
  （`.httpEtag` 形式）を渡すと `R2Bucket#get()` が `TypeError: Conditional ETag should not be wrapped
  in quotes` を throw する（マッチ失敗ではなく例外）。
- R2 の `get` は condition 不一致でも **reject せず resolve** する（`R2GetPreconditionFailed` として
  観測、JS 側 try/catch 封筒は不要）。D1 の `run`/`batch`/`exec` が真の例外を throw するのとは対照的
  （[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) 追補の決定 1 参照）。

### 遵守事項への影響（本文 override）

本文「遵守事項 (Compliance)」の以下の項目は、本追補により実装レベルの解釈を確定する（本文自体は
書き換えない）。

- 「必須設定は起動時に検証し、欠落/不正時は明確に失敗させる（実行時まで遅延させない）。」
  → **追補により「起動時」を per-request の `BindingEnv` 構築時と定義**。宣言済み binding の欠落は
  毎リクエストの env 構築時に全数検査し、`BindingMissingError` → 既存の 500 + `tailLog` 経路に落とす。
  専用のエラー経路は設けない（決定 1）。
- 「非同期リソース操作は async JSFFI として型に反映する。」
  → **追補により具体化**: KV/D1/R2 の非同期メソッドは Promise 性に応じて `safe`/`unsafe` を割り当てる
  （割当規則は [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) 追補参照）。options/values は
  incremental object build（決定 3）で構築する。

### 参考資料（追補分）

- [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) 追補（JSFFI 境界の実装規約 — safe/unsafe 割当・
  JS 側 try/catch 封筒）
- [ADR-0019](./0019-monorepo-package-layout.md) 追補（二重ビルド方式・`Internal/FFI/*` 隔離の適用範囲）
- Cloudflare Workers — KV Binding API: https://developers.cloudflare.com/kv/api/
- Cloudflare Workers — D1 Worker Binding API: https://developers.cloudflare.com/d1/worker-api/
- Cloudflare Workers — R2 API reference: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

## 追補 (2026-07-23): A4 で確定した dos slot / DO storage / doFetch・serviceFetch の URL 再構成

- ステータス: 承認（追補）
- 日付: 2026-07-23
- 決定者: lihs

Phase A theme A4（Durable Objects の fetch/RPC/`dos` slot/WebSocket hibernation/SQLite ストレージ、
Service Bindings、実機検証済み）で確定した設計のうち、A4 で新規に追加された分を記録する。KV/D1/R2
（A3 分）は上の追補で既に記録済みのため、本追補では扱わない。本文自体は書き換えない。

### 決定 1: `dos` slot の実体化 — `getDurableObjectNamespace` + `RequireDurableObjectNamespace` 型族 +
`BuildDosEnv` 別 class + 起動時 `BindingMissingError`

`Env`（`BindingEnv`）の `dos :: [Symbol]` phantom 型パラメータ自体は A2（Unit 8）の時点から存在したが、
それを裏付けるランタイムアクセサは A4 まで一切存在しなかった。A4 で以下を実体化した。

- `getDurableObjectNamespace :: (KnownSymbol sym, RequireDurableObjectNamespace sym dos) => Proxy sym
  -> BindingEnv kvs dos bindings -> DONamespace` — `getBinding` の「`dos` 版」として同型（A4 plan の
  明示的な指示）だが、構造は一部簡素: `dos` の各エントリは常に `DONamespace` 型のため
  `Data.Dynamic`/`Typeable` の往復が不要。
- `RequireDurableObjectNamespace :: Symbol -> [Symbol] -> Constraint`（型族）— 「`sym` が `dos` の
  メンバーか」という型レベル gate（`'[]` の base case を持たず、不在の `sym` は型族を stuck にする
  ことでコンパイル時にブロックする — `BindingType` が `bindings` に対して既に使っている手法と同じ）。
- `BuildDosEnv (dos :: [Symbol])` — `BuildBindingEnv` とは**別の class**（`class BuildDosEnv dos where
  buildDosEnv :: Proxy dos -> Map Text JSVal -> IO (Map Text DONamespace)`）。`dos :: [Symbol]` と
  `bindings :: [(Symbol, Type)]` は kind が異なり、`dos` 側の fold は `bindings` 側よりさらに単純
  （`dos` エントリは全て一様に `DONamespace` 型なので per-entry `FromBindingJSVal` インスタンスの
  選択が不要）。単一 fold へ統合するか別 class にするかは A4 plan が実装者判断に委ねた事項 —
  統合すると kind-indexed class 階層という機構が増え、既にわずかな fold ボイラープレートの重複を
  消すために見合わないという判断で別 class を選択した。
- `BindingEnv` のランタイム表現は `Map Text Dynamic` 単一から `Map Text Dynamic` + `Map Text
  DONamespace` の 2 マップへ **breaking**（コンストラクタの arity 変更）。ただし**公開型シグネチャと
  3 つの phantom 型引数（`kvs`/`dos`/`bindings`）は不変**（A4 plan の明示的な裁定）。既存の one-off
  `BindingEnv` 構築呼び出し（`probeKvRoundtrip`/`probeD1Roundtrip`/`probeR2Roundtrip`、`Spec.hs` の
  `envTests` フィクスチャ）は機械的な更新（第 2 引数に `Map.empty` を追加）のみで済んだ。
- 起動時検証: `BuildDosEnv` の fold で宣言済み `dos` slot 名が実 `env` に無ければ、A3 で確立した
  `BindingMissingError` を再利用して throw する（`dos` 専用の別エラー型は新設しない — 1 つの共有
  例外型で `bindings`/`dos` 両方の fold をカバーする）。上の追補（A3 分「決定 1」）が確立した
  「起動時 = per-request `BindingEnv` 構築時」という解釈をそのまま踏襲する。

### 決定 2: DO storage = KV スタイル API + transaction は操作リスト一括適用（Haskell closure を txn
callback に渡さない設計判断）

```haskell
doStorageGet :: DOStorage -> Text -> IO (Maybe ByteString)
doStoragePut :: DOStorage -> Text -> ByteString -> IO ()
doStorageDelete :: DOStorage -> Text -> IO Bool
doStorageList :: DOStorage -> Maybe Text -> Bool -> Maybe Int -> IO [(Text, ByteString)]
doStorageTransaction :: DOStorage -> [DOStorageOperation] -> IO (Either DOError ())

data DOStorageOperation = DOStorageOperationPut Text ByteString | DOStorageOperationDelete Text | DOStorageOperationFail
```

`DOStorage` は宣言済み `wrangler.toml`/`dos` slot binding ではない — 個々の DO インスタンス固有の
`ctx.storage` に組み込まれており、DO クラスメソッドが `ctx` から直接取り出して渡す（`BindingEnv`/
`dos` fold の構築を経由しない）。

**設計判断（A4 plan の明示的な裁定）**: `DOStorage -> (DOStorage -> IO a) -> IO (Either DOError a)`
という、実際の Haskell クロージャを `txn` コールバックとして走らせるシグネチャは、A4 plan が
「A1 の危険領域」（JS が Haskell クロージャへコールバックする類のハザード）として明示的にフラグを
立て、この batch では一切試みなかった。代わりに `doStorageTransaction` は事前に組み立てた
`[DOStorageOperation]` を丸ごと受け取り、リスト全体を 1 回の JS 配列として FFI 境界を越え、実 `txn`
コールバック（純粋 JS 側）がそれをループして `txn.put`/`txn.delete`/throw を適用する — ループの中に
Haskell クロージャは一切登場しない。トランザクション途中の条件分岐を Haskell 側から決定する、真の
意味での per-operation コールバックはスコープ外（follow-up）。

**値の形（structured-clonable「byte bridge」）**: 保存する値は常に実 JS `Uint8Array` として FFI
境界を越える（「structured-clonable 前提の bytes 主」という A4 plan の裁定）。`doStorageGet`/
`doStorageList` は `doStoragePut` が書き込んだのと**全く同じ** `Uint8Array` 形状を返す（実 DO
storage は structured-clonable 値の具体型をそのまま往復させる — `KVNamespace` の `{ type:
'arrayBuffer' }` 読み取りオプションが常にプレーンな `ArrayBuffer` を返すのとは異なり、
`Internal.FFI.KV` 方式の `new Uint8Array(arrayBuffer)` 再ラップは不要）。

**rollback 実挙動**: put→put の commit、delete+put の混在 commit に加え、**rollback**（put → 意図的な
`DOStorageOperationFail` タグ付き失敗 → 別の put という順で、トランザクション全体がロールバックされる
こと、失敗より前に走った操作のキーも含め両方の `get` が `Nothing` を返すこと）を実（SQLite-backed）
DO instance に対して実機検証した。

### 決定 3: `doFetch`/`serviceFetch` の URL 再構成 = placeholder + path + query（`urlQueryRaw`）、
非可逆 2 点

`doFetch`（`Cloudflare.Workers.Binding.DurableObject`）と `serviceFetch`（`Cloudflare.Workers.Binding.
ServiceBinding`）はいずれも、渡された `Request` から実ネイティブの `Request` を再構築して DO/Service
Binding 側へ渡す。`Cloudflare.Workers.HTTP.Request` の `URL` フィールドは元の絶対 URL テキストを
一切保持せず、パース済みのパス + クエリパラメータ map のみを保持する（`Cloudflare.Workers.
Entrypoint.Fetch` の marshal 境界で一度パースされた時点で捨てられている）ため、再構築される URL は
次の 3 要素の連結になる。

1. 固定の意味を持たないプレースホルダ scheme+host（`doFetch` は `https://do-internal.invalid`、
   `serviceFetch` は `https://service-binding-internal.invalid`）
2. `Cloudflare.Workers.URL.urlPathRaw`
3. （A4 close reviewer fix #a で追加、new）`?` + `Cloudflare.Workers.URL.urlQueryRaw`、クエリ文字列が
   非空の場合のみ付与

`urlQueryRaw :: URL -> Text`（new）は `urlQueryParametersField` から `parseQueryString` の最も近い
逆写像としてクエリ文字列を再構成する。各エントリは `k`（`=` 無し）または `k=v` としてレンダリング
され（`parseQueryString` 自身の 2 ケースを鏡写しにする）、`&` で結合する。

**非可逆な 2 点（Haddock に明記済み、設計上の意図的なスコープ限定）**:

1. 再構成されたエントリは `Map.toAscList`（キーの昇順）順にレンダリングされる — 元のキー横断での
   左から右の順序を必ずしも保持しない。
2. 再パーセントエンコーディングは行わない — デコード済みの値がリテラルな `&`/`=`/`%` を含む場合、
   曖昧にレンダリングされる。

この機能追加以前は、クエリ文字列は再構成先の URL から静かに欠落していた（`doFetch`/`serviceFetch`
それぞれの API-LEDGER エントリに個別に記録されていたスコープ限定）。A4 close の reviewer fix #a に
よりこの欠落は解消されたが、上記 2 点の非可逆性は残る。

### 実測で確定した挙動（記録）

- Service Binding / DO の RPC stub は Proxy-backed で `Function.prototype.apply` を受け付けない —
  `stub[methodName](...args)`/`service[methodName](...args)` の spread-call 構文が必須
  （`doCall`/`serviceCall` 双方で確認）。
- 自己参照 `[[services]]` binding は `@cloudflare/vitest-pool-workers` 0.18.7 上で補助 Worker
  無しに解決できる。
- 非 `WorkerEntrypoint`（プレーンな `{ fetch, ... }` export）の Service Binding に対する RPC 呼び出し
  は、汎用の "method does not exist" `TypeError` ではなく、区別可能な自己記述的エラーとして分類
  される。

### 遵守事項への影響（本文 override）

- 「Durable Objects（ADR-0010 と連携）・Queues・Cache は後続で拡充する」→ 追補（A3 分の既存追補 +
  本追補）により、Durable Objects（fetch/RPC/`dos` slot/WebSocket hibernation/storage）・Queues
  （producer/consumer）は A4 でいずれも実配線済み。Cache API は引き続き未着手。

### 参考資料（追補分）

- [ADR-0010](./0010-websockets-durable-objects.md) 追補（A4 分。hibernation 主実装、
  `WebSocketMessagePayload`）
- [ADR-0016](./0016-non-fetch-entrypoints.md) 追補（A4 分。`mkScheduledHandler`/`mkQueueHandler`/
  `mkTailHandler`、絶対時刻 Integer / 相対値 Int の型規約）
- 実装詳細・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a4-plan.md`、
  `_phase_b/divergence-notes.md`「A4 batch 2」「A4 batch 5」節・「Finding 3」、`API-LEDGER.md` 該当節

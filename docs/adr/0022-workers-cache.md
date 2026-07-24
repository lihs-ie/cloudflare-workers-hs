# ADR-0022: Workers Cache は値レベル typed builder と servant 型レベル combinator の両方を提供する

- ステータス: 承認（実装済み・全ゲート EXIT 0。遵守事項の RE 行 [hit/miss/purge 実測] は Phase A theme
  A7 close の RE 一括バッチで実施済み — Cache-Control emit ✅ / purge 204 ✅ だが **HIT 未達**、原因
  切り分けは A8 送り。詳細は本文末尾「RE 追補」節参照）
- 日付: 2026-07-24
- 決定者: lihs
- 関連: [ADR-0006](./0006-servant-execution-engine.md)（servant 実行エンジン — `HasWorkerServer` の第 2 の custom instance）、[ADR-0008](./0008-cloudflare-platform-bindings.md)（プラットフォームバインディング — `ctx` 経由の Cloudflare API 供給）、[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)（`ZeroTrust` combinator の先例）

## 背景と課題 (Context)

Phase A theme A7 の要求（`phase-a-acceptance-checklist.md` 項目 15）は「型付き Cache-Control combinator
+ Cache-Tag ヘッダー + `ctx.cache.purge` adapter + quickstart 組込 + RE（hit/miss/purge）」を要求する。
この文言は「型付き」を「servant 型レベル combinator」と読めるが、A7 着手時点でこの codebase にカスタム
servant 型レベル combinator の実装例は `servant-cloudflare-workers-access` の `ZeroTrust`（ADR-0009）
1 件のみで、Cache 領域では値レベル・型レベルいずれの実装も存在しなかった。

A7 の要裁定 2（lihs 裁定 2026-07-24）は「値レベル typed builder」と「servant 型レベル combinator」の
どちらを採用するかを問うたが、**lihs の裁定は「1+2 = 両方必達」**（stretch 扱いの選択肢は非選択）。
本 ADR はこの裁定と、両方を実装した結果確定した設計（責務分担・優先順位規約・mutual exclusivity の
扱い）を記録する。

### Workers Cache API の要点（Context7 で現行ドキュメントと照合済み）

- `ctx.cache.purge(options): Promise<{success: boolean, errors: {code: number, message: string}[]}>`
- `options` は `{ tags?: string[] }` / `{ pathPrefixes?: string[] }` / `{ purgeEverything?: boolean }` の
  3 択（相互排他）
- ローカル開発（`wrangler dev`）での有効化は `wrangler.toml` の `[cache]\nenabled = true`（Wrangler
  4.69.0 以上）
- 出典: <https://developers.cloudflare.com/workers/cache/purge/index.md>、
  <https://developers.cloudflare.com/workers/cache/configuration/index.md>

### Step 0 probe (i) の実測結果（この ADR の前提事実）

生 `wrangler dev`（`vitest-pool-workers` とは別実装、後者では未確認）に対して実施:

- `[cache]\nenabled = true` は wrangler 4.113 で config parse に成功する（拒否されない）
- **`ctx.cache` はローカル実行時に `undefined`** — カウンタ付き最小ハンドラへの 2 回連続 curl でも
  cache ヒットは観測できず（`cf-cache-status` 相当ヘッダーなし、ハンドラは毎回実行されカウンタが
  毎回増分）
- 帰結: この Unit の T2 スコープは「ヘッダー出力の検証」までであり、hit/miss/purge の実挙動は RE
  （実 Cloudflare edge 越しのデプロイ）でのみ確認する

## 決定要因 (Decision Drivers)

- lihs 裁定「値レベル builder と servant 型レベル combinator の両方必達」を満たすこと
- 既存アーキテクチャ（`ZeroTrust` の先例、A6 封筒化パターン、FFI boundary allowlist）からの逸脱を
  最小化すること
- 型レベル combinator と値レベル builder が Cache-Control 文字列レンダリングを二重実装しないこと
  （combinator は builder の `renderCacheControl` を型レベル→値レベルの demote 後に再利用する）
- `ctx.cache` がローカルで存在しない（Step 0 probe (i)）という制約下でも、cachePurge の型シグネチャ・
  T1 テスト・quickstart 組込の設計だけは完了できること（実 hit/miss/purge の実証は RE に委譲）
- 「宣言的な combinator のデフォルト」と「レスポンスを実際に構築した側が持つ、より具体的な意図」が
  衝突したときに、後者が勝つという HTTP ヘッダー全般の直感と整合する優先順位を持つこと
  （orchestrator レビューで指摘された設計穴 — 後述）

## 検討した選択肢 (Considered Options)

### Cache-Control combinator の実装層（要裁定 2 の原案）

1. 値レベルの typed builder のみ（`CacheControlDirective` ADT + `renderCacheControl` + quickstart で
   手動適用）
2. servant 型レベル combinator のみ（`CacheControlled '[MaxAge 3600, Public] :> api`）
3. **両方**（1 を土台に、2 は 1 の `renderCacheControl` を型レベルから demote して再利用する — 二重
   実装しない）

### CacheControlled combinator の実装方式（型レベル → 値レベルの橋渡し）

A. `Servant.API.ResponseHeaders.Headers h a` 拡張 `Verb`/`Stream` の `HasWorkerServer` instance を
   新設し、ハンドラ自身が型付きヘッダーを返す（real `servant-server` の `Headers` 機構と同じ形）
B. **`route` レベルでレスポンスを後処理する combinator**（`Router'`/`RouteResult` が既に derive
   している `Functor` を `fmap` で 2 段重ねし、リーフの `RoutingApplication` が返す
   `Cloudflare.Workers.HTTP.Response` へ後から `Cache-Control` を挿入する）

### Cache-Control の優先順位（combinator vs 明示設定）— orchestrator レビューで追加された論点

X. combinator が常に上書きする（無条件）
Y. **combinator は「値が不在のときだけ」ヘッダーを設定する（宣言的デフォルト、明示値が常に勝つ）**

## 決定 (Decision)

採用する選択肢:

- Cache-Control combinator の実装層 = **選択肢 3（両方）**。`Cloudflare.Workers.Cache`（`cloudflare-workers`
  パッケージ）が値レベルの実体（`CacheControlDirective` ADT / `renderCacheControl` / `cacheTagHeader`
  / `cachePurge` FFI adapter）を持ち、`Servant.Cloudflare.Workers.CacheControl`（`servant-cloudflare-workers`
  パッケージ）が型レベル `CacheDirective` リストを `KnownCacheDirectives` で値レベルへ demote し、
  `renderCacheControl` にそのまま渡す。Cache-Control 文字列のレンダリングロジックは `renderCacheControl`
  一箇所のみ。
- CacheControlled の実装方式 = **選択肢 B（route レベルの後処理）**。この codebase には
  `Headers h a` 拡張 `Verb` の `HasWorkerServer` instance が存在せず（新設は設計コストが高く、
  この Unit のスコープを超える）、`Router'`/`RouteResult` が既に `Functor` を derive している事実を
  利用すれば新規機構ゼロで実装できるため。`ServerT (CacheControlled directives :> api) m = ServerT api m`
  （`ZeroTrust` と異なりハンドラのシグネチャを一切変えない）。
- Cache-Control の優先順位 = **選択肢 Y（明示値が勝つ、combinator は不在時のみ設定）**。
  `addCacheControlHeader` は `headerLookup "Cache-Control"` で既存値の有無を確認し、存在すれば
  何もしない。この codebase では通常の `Verb` ハンドラが直接ヘッダーを設定する手段がないため
  （選択肢 A を採用しなかった帰結）、この優先順位は主に `Raw` combinator 配下のハンドラ（生の
  `Response` を自分で構築できる唯一の場所）との組み合わせで意味を持つ。servant-cloudflare-workers
  の unit テスト（`cacheControlledCombinatorTests`）に `Raw` を `CacheControlled` でラップし、
  ハンドラが自分で `Cache-Control: no-store` を設定した場合に combinator のデフォルト
  （`public, max-age=3600`）で上書きされないことを確認するケースを追加した。
- **mutual exclusivity（`Public`/`Private`/`NoStore` の同時指定）は型レベルで拒否せず、実行時
  normalize** で解決する（裁定 2 が明示的に許容する 2 案のうち後者）。型レベルで拒否するには
  closed type family ないし custom type error でリストを畳み込み時に検査する必要があり、
  設計コストに対して本 Unit のスコープでの効用が不明瞭と判断した。実装は
  「型レベルリストを demote したトークン列を左から右へ fold し、`Public`/`Private`/`NoStore`
  トークンは最後に出現したものが勝つ（`Cloudflare.Workers.Headers.headerInsert` と同じ
  "後勝ち" 規約）。1 つも出現しなければ `CachePrivate`（保守的デフォルト）」という規約に確定した。
  ドキュメントは `Servant.Cloudflare.Workers.CacheControl` モジュール Haddock に明記。
- **`ctx.cache.purge` は A6 封筒化パターン（`Cloudflare.Workers.Internal.FFI.Envelope`）に従う**。
  JS 側 `try`/`catch` で real reject を `{ ok: false, message }` へ正規化し、`decodeEnveloped` で
  `Either Text a` に変換、`Left` は `CachePurgeFailed`（Haskell 例外）として `throwIO` する。
  **`ctx.cache` がローカルで `undefined`（Step 0 probe (i)）である場合、`.purge` プロパティ読み取りが
  同期的 `TypeError` を投げる — この JS 例外も同じ `try`/`catch` に捕捉され、genuine reject と同一の
  `{ ok: false, message }` 形になる**。つまり「API 不在」と「API は存在するが reject（quota 超過等）」
  は `cachePurge` の呼び出し側からは区別できず、どちらも `CachePurgeFailed` として一律 throw される
  ── これは意図的な設計（区別する必要がない: どちらも「purge できなかった」という同じ結果）。
  対して、real Purge API 自身が返す `{ success: false, errors: [...] }`（個別タグの purge 失敗）は
  正常な resolve であり、`CachePurgeResult { cachePurgeResultSuccess = False, ... }` という**例外では
  ない**値として扱う。この dispatch ロジック（`Either Text (Bool, [(Int,Text)]) -> IO CachePurgeResult`）
  は `handleCachePurgeOutcome` として独立させ、host GHC 上で実 FFI なしに直接ユニットテストできるように
  した。
- quickstart 組込: `GET /r/:code`（短縮 URL リダイレクト）に `CacheControlled '[MaxAge 3600, Public]`
  を適用（型レベル combinator の実演）。同じルートへ、捕捉した `code` を使って `Cache-Tag: url:<code>`
  を `FetchHandler` 層（`fetchHandler` 自身、既存の `x-probe-request-query` 前例と同じ層）で付与する
  （値レベル builder の `cacheTagHeader` の実演 — 型レベル combinator では捕捉値にアクセスできないため、
  この ヘッダーだけは combinator を通さない）。新規 `DELETE /shorten/:code` ルートで KV 削除 +
  `cachePurge ctx (PurgeTags ["url:<code>"])` を実演（purge 呼び出し自体は best-effort — 失敗しても
  KV 削除という主効果を 500 にしない）。

## 結果 (Consequences)

### 良い結果 (Positive)

- Cache-Control のレンダリングロジックは 1 箇所（`renderCacheControl`）のみで、値レベル・型レベル
  両方の利用者が同じ実装を共有する。
- `CacheControlled` の実装は `Router'`/`RouteResult` の既存 `Functor` instance を再利用するだけで、
  新規のルーティング機構やレスポンス表現の変更を要さない（低リスク）。
- `cachePurge` の封筒化は A6 で確立したパターンをそのまま横展開でき、既存の FFI boundary allowlist・
  `verify-ffi-boundary.sh` に一切変更を要さない。
- ローカルで `ctx.cache` が存在しなくても（Step 0 probe (i)）、型シグネチャ・T1 テスト・quickstart
  配線は全て完了できる ── real API の有無に実装の完成度が左右されない設計。
- combinator の優先順位規約（明示値が勝つ）により、将来 `Headers h a` 拡張 `Verb` instance を追加
  した場合でも、ハンドラが明示的に設定した値が黙って上書きされるという事故を防げる。

### 悪い結果・トレードオフ (Negative)

- `CacheControlled` は `Verb`/`Stream` レスポンスのステータスコードを見ずに `Cache-Control` を
  付与する（2xx/4xx を区別しない） ── 例えば `GET /r/:code` が 404 を返すケースでも combinator の
  デフォルト `public, max-age=3600` が付与される（実測: `cache-control.spec.ts`）。ステータスコード
  に応じた条件付きキャッシュ制御は本 Unit のスコープ外（将来の拡張候補、後述）。
- mutual exclusivity を型レベルで拒否しないため、`'[Public, NoStore]` のような矛盾した宣言が
  コンパイルを通り、silent に「後勝ち」で解決される（ドキュメント化済みだが、コンパイルエラーでは
  ない）。
- `ctx.cache` の不在と real reject を区別できないため、RE で「ローカルでは検証できなかった実際の
  purge 成功/失敗」を確認するまで、この adapter の実運用での挙動は未実証のままである。
- `CacheControlled` は `Headers h a` 拡張 `Verb` instance を持たないため、ハンドラ自身が
  Cache-Control を明示設定できるのは事実上 `Raw` combinator 配下に限られる（優先順位規約自体は
  一般的に定義したが、実際に発動する場面は現状の codebase では限定的）。

### 中立・フォローアップ (Neutral / Follow-up)

- ステータスコードに応じた条件付き Cache-Control（例: 2xx のみキャッシュ、4xx/5xx は no-store 強制）
  は、この Unit ではスコープ外とした ── 必要になった場合は `CacheControlled` に
  `responseStatus response` を見る分岐を追加する形で拡張可能（`addCacheControlHeader` は既に
  `Response` 全体を受け取っている）。
- `Headers h a` 拡張 `Verb`/`Stream` の `HasWorkerServer` instance の新設は、この ADR のスコープ外
  だが、将来追加された場合は `CacheControlled` の優先順位規約（明示値が勝つ）がそのまま適用できる
  設計にしてある。
- RE（Phase A theme A7 close の一括バッチ）で hit/miss/purge 後再 miss を実測し、本 ADR に追補する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### Cache-Control combinator: 値レベル builder のみ

- 利点: 実装コストが最小、既存アーキテクチャからの逸脱がゼロ。
- 欠点: checklist 項目 15 の「型付き combinator」という文言を字義通り満たさない。lihs 裁定により不採用。

### Cache-Control combinator: servant 型レベル combinator のみ

- 利点: checklist の文言を字義通り満たす。
- 欠点: 値レベルの purge adapter・Cache-Tag builder は別途必要であり、結局値レベル実装を持つことになる
  （「型レベルのみ」は実質的に成立しない）。lihs 裁定により不採用（「両方」明示選択）。

### Cache-Control combinator: 両方（採用）

- 利点: 裁定を満たし、レンダリングロジックの共有により二重実装を避けられる。
- 欠点: 見積り +1 Unit 分（Unit d を d1/d2 に分割）。

### CacheControlled 実装方式: `Headers h a` 拡張 `Verb` instance

- 利点: real servant-server と同じ、ハンドラが型付きヘッダーを直接返せる。
- 欠点: この codebase に前例がなく、`HasWorkerServer` instance を新設するコストが高い。
  `Verb`/`Stream` 双方に必要となり、本 Unit の見積りを大きく超える。

### CacheControlled 実装方式: route レベル後処理（採用）

- 利点: 既存の `Functor` derive を再利用するだけで実装でき、ハンドラのシグネチャを一切変えない。
- 欠点: ハンドラ自身がヘッダーを明示設定する手段が（`Raw` 以外に）ないため、優先順位規約の実地での
  発動機会が限定的。

### Cache-Control 優先順位: combinator が常に勝つ

- 利点: 実装が最も単純（無条件 `headerInsert`）。
- 欠点: 将来 `Headers h a` instance が追加されたときにハンドラの明示的意図を毎回黙って握り潰す
  ── HTTP ヘッダーの一般的な直感（より具体的な指定が勝つ）に反する。orchestrator レビューで
  明示的に指摘され、不採用。

### Cache-Control 優先順位: 明示値が勝つ（採用）

- 利点: HTTP/servant の一般的直感と整合、将来の拡張と衝突しない。
- 欠点: 「明示値」を判定する `headerLookup` の一手間が増える（軽微）。

## 遵守事項 (Compliance)

- [x] `renderCacheControl` は `Cloudflare.Workers.Cache` の 1 箇所のみに存在し、
      `Servant.Cloudflare.Workers.CacheControl` はそれを呼び出すのみで再実装しない。
- [x] `ctx.cache.purge` の FFI 呼び出しは `Cloudflare.Workers.Internal.FFI.Cache`（`*/Internal/FFI/*.hs`）
      にのみ存在する（`verify-ffi-boundary.sh` で機械検証）。
- [x] `cachePurge` は A6 封筒化パターン（JS 側 `try`/`catch` → `decodeEnveloped` → `Either` →
      call-site 分類済み例外）に従う。
- [x] `CacheControlled` は既存のレスポンスヘッダーを上書きしない（`headerLookup` で不在確認してから
      挿入）。
- [x] RE（Phase A theme A7 close）: hit（2 回目リクエストの観測）/ miss（初回・purge 直後）/ purge
      実行 → 再 miss の実測を本 ADR に追補する。

## RE 追補（2026-07-24、theme A7 close、Version `3e381073`、cache 有効 + real Access appContext）

`_phase_a/a7-plan.md`「★RE バッチ実測結果」表が正。実 edge（`GET /r/:code`、
`CacheControlled '[MaxAge 3600, Public]` + `Cache-Tag` 値レベル builder 適用済みルート）に対して
実施:

- **Cache-Control emit**: `Cache-Control: public, max-age=3600` を edge 応答で確認 ✅（d2 の型レベル
  combinator が edge でも設計通り動作）。
- **HIT 未達**: 5 回連続試行、全て `cf-cache-status` が MISS（BYPASS ではない）。BYPASS でないという
  ことは cache 層自体はリクエストを照会しているが、store が何らかの理由で保存/参照を拒否している
  ことを意味する。**原因は特定できていない** — 容疑は 2 つ: (1) Access 相互作用（対象 hostname
  全体が Access で保護されておりリクエストに認証 cookie が付与される構成のため、Cache API が
  cookie 付きリクエストを cacheable と判定していない可能性）、(2) Free plan の Workers Cache store
  制限。原因切り分けは A8/Phase B research へ送る（下記「A8 送り事項」参照）。
- **Cache-Tag strip**: `cacheTagHeader` で付与した `Cache-Tag: url:<code>` ヘッダーは edge 応答から
  **strip される**（Cloudflare の既知挙動 — `Cache-Tag` は内部 purge 用メタデータとして消費され、
  クライアントへは返さない）。値レベル builder 自体は設計通り動作しているが、ヘッダーの往復確認
  という検証方法そのものが Cache-Tag には使えないと判明した。
- **Purge**: `DELETE /shorten/:code` 経由の `cachePurge` 呼び出しは `204`（envelope 上の事故なし、
  A6 封筒化パターンが real edge でも正常動作）。ただし HIT が一度も観測できていないため、
  「purge 実行 → 再 miss」という遵守事項の意図した検証（hit の後に purge して miss に戻ることの
  確認）は**純粋には検証不能**（miss の前段階である hit 自体が存在しないため、"purge が効いて
  miss に戻った" のか "そもそも一度も hit していない" のかを区別できない）。
- **総括**: `Cache-Control` emit と purge 呼び出し自体（500 にならないこと）は実 edge で実証できたが、
  本 ADR の中核機能である cache hit は実証できなかった。この ADR の「実装済み」ステータスは
  型シグネチャ・T1/T2・quickstart 配線について変わらず有効だが、**実 edge での hit 挙動は未実証の
  まま theme A7 を close する**ことを正直に記録する。原因切り分け（Access 相互作用 vs Free plan
  store 制限）は A8 送り。

## 参考資料 (References)

- Cloudflare Docs — Purge Cache: <https://developers.cloudflare.com/workers/cache/purge/index.md>
- Cloudflare Docs — Cache configuration（`wrangler.toml` `[cache]`）:
  <https://developers.cloudflare.com/workers/cache/configuration/index.md>
- 実装・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a7-plan.md`
  「### Unit d」節・裁定欄（裁定 2）・「実行状態」節（Step 0 probe (i) 結果）、
  `API-LEDGER.md`「A7 Unit d」節
- `cloudflare-workers/src/Cloudflare/Workers/Cache.hs`（値レベル builder 実装）
- `servant-cloudflare-workers/src/Servant/Cloudflare/Workers/CacheControl.hs`（型レベル combinator 実装）
- `cloudflare-workers/src/Cloudflare/Workers/Internal/FFI/Cache.hs`（`ctx.cache.purge` FFI adapter）
- `examples/quickstart/test/integration/cache-control.spec.ts`（T2）

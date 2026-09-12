# ADR 一括レビューダイジェスト (2026-07-24)

> **本ファイルは commit 対象外の一時レビュー補助ファイルです。**
> ファイル名の `_` prefix は「レビュー用スクラッチ、正典 ADR ではない」を示します。
> lihs が内容を確認し commit する際、本ファイル自体は削除してください（`git add` の対象に含めないこと）。
> 対象: `docs/adr/` 配下 uncommitted 変更 15 ファイル（M 11 + README M 1 + 新規 3）。

---

## 判断が要る箇所 一覧（ファイル横断・重要度順）

以下は「事実の記録」ではなく、**lihs の裁定・レビュー・本文修正判断が絡む/絡みうる**箇所です。commit 前に優先して目を通す想定です。

1. **[最重要] 0009 決定2 — JWKS キャッシュ方式が本文から変更（KV/Cache → isolate-lifetime IORef）**
   本文「決定」節は JWKS を KV/Cache でキャッシュすると述べていたが、実装は isolate 生存期間の `NOINLINE IORef`（capacity=1）に確定。理由は妥当だが、**認証のクリティカルパスの挙動が本文記述と食い違う**ため、本文修正の要否を含め確認価値あり。

2. **[最重要] 0009 残課題 — KV durability の未解決 finding（実 Access 経由の RE 実測）**
   `POST /shorten` が 200 を返した後、対応する KV key が実 namespace の `list`/`get` いずれからも見つからない（60秒超待機後も再現）。**Promise は resolve しているが永続化されたかは未観測**。A8 real edge E2E で最優先調査事項に昇格、と記載あるのみで現時点は未解決のまま残置。

3. **0009 — 本文「servant コアの AuthProtect を用い」の実態乖離**
   本文は Servant 統合方式を「`AuthProtect`（純 Haskell、再利用可）を用い」と記述していたが、**実装は `AuthProtect` を一切再利用していない**（A2 Unit7 の自前 `ZeroTrust`/`AccessVerifier` combinator のまま）。追補内で明示的に「本文の表現は実装の実態と食い違うため、ここに注記する」と記録。本文修正するか、追補注記のみで運用するかは判断余地あり。

4. **0013 決定1 — LogLevel/LogRecord 実装差分（明示的な乖離記録、例示項目）**
   追補ドラフトの `LogLevel` コンストラクタ名 `Debug|Info|Warn|Error` に対し実装は `LogDebug|LogInfo|LogWarn|LogError`。`LogRecord.logRecordMethod`/`logRecordPath` はドラフトでは `Text`（必須）だが実装は `Maybe Text`。追補内で「実装時の妥当な変更」と自己判定済みだが、**乖離が生じたこと自体はレビュー対象**。

5. **0019 — 二段階追補（07-22 設計の逸脱 → 07-24 lihs 裁定で本文骨格へ回帰、実装は未着手）**
   07-22 追補が導入した CPP `#if defined(wasm32_HOST_ARCH)` 方式が、spike 実装で public/production モジュールにまで広がり「シム/実装ドリフト排除」という本来の意図から外れた（既知逸脱）。lihs が 2026-07-24 の grill（`production-extension-grill.md` E-Q13）で「自前 vendored module（`data JSVal` のみ ~10行）による host 型シムへ回帰、CPP は `Internal/FFI/*` 限定に縮退」を裁定。**この裁定は既に lihs 自身が下したものだが、実装（theme A6b）は本追補時点でまだ未着手** — plan 確定のみの起票である点に注意。

6. **0008 決定8 ★訂正 — timestamp/size 型の overflow バグ修正記録**
   当初「絶対値/相対値とも `Int` 統一」としていたが、`wasm32-wasi` の GHC は `Int` が 32-bit のため実機で silent wrap（例: `R2ObjectMeta.r2ObjectMetaUploaded` が負値化）。reviewer iter2 でさらに `D1Meta.d1MetaLastRowId` 等 3 フィールドの **FFI 境界自体が `IO Int` のままだった**という追加バグを発見・修正（Haskell 側フィールド型が `Integer` でも FFI 境界の型が別問題という教訓付き）。影響範囲が KV/D1/R2/Queue/Scheduled/Tail の timestamp 全般に及ぶため一覧化。判断というより「見逃されやすい修正」として認識共有目的。

7. **0010 決定3 — servant WebSocket combinator は A4 では未実装のまま**
   本 ADR 本文の中核（`WebSocketCloudflare` のような組み合わせ子を Servant 宣言的記述に組み込む）は A4 スコープ外。実装済みは DO クラスメソッドへの JS glue 委譲のみで、Servant API 型で WebSocket エンドポイントを宣言する経路は現状存在しない。本文「結果」節の Positive な主張が**未充足のまま**据え置かれている点、認識要。

8. **0002 — 選択肢2（自前最小 WASI shim）の扱いが open のまま**
   本文は当初「選択肢1→2へ移行」の方針だったが、追補は「選択肢1の実装差し替え」に留め、選択肢2への移行は**引き続き open のフォローアップ**とした。優先度づけの判断は今回されていない。

9. **0012 / 0013 — U13 実装確認セクションの差分有無（0012=差分なし／0013=差分あり）**
   両追補とも「plan確定」版のあとに「実装確認 (2026-07-24, batch A6-6 U13)」節が追記され、実コードとの突合結果が記録されている。0012 は「差分: なし」、0013 は「差分: 決定1の2点」（=上記4番）。この確認済み/未確認のペア構造自体が今回初出であり、lihs が把握しておくべき運用パターン。

10. **0019 テスト構成節 — ADR-0017 の三層テスト分類を物理配置へ解釈した箇所（新規ファイル初回レビュー）**
    0019 は新規ファイルであり全体が初回レビュー対象。特に「テスト構成」節（tier1=各パッケージ `unit` スイート、tier3=server パッケージ `compat` スイート、tier2=`examples/quickstart/test/integration/*.ts`）は ADR-0017 が定義した三層テスト分類を初めて物理配置へ落とし込んだ解釈であり、他 ADR からの参照（0017 追補・0020 の検証サイクル）とも整合しているか確認価値あり。

---

## 単なる事実記録（判断不要、参考情報）

以下は「実測で確定した挙動」「foot-gun 注意」「参考資料追加」など、判断を要さず記録として転記されたもの。詳細はファイル別詳細を参照。

- 0003: JSFFI `try @JSException` が bare `safe` import の reject を捕捉できない toolchain 制約（実機確認済み）、JSString が FFI 境界を越えられない実測、probe export の scope 限定。
- 0006: servant conformance の実測意味論（`Capture` 解析失敗は400、パス処理順序等）。
- 0008 (A3): binding 配線の型レベル fold 設計、R2 バケット名がハイフンのみ許可、`onlyIf` は bare 形式必須、等。
- 0008 (A4): `dos` slot 実体化、DO storage API 形状、RPC stub が spread-call 必須（`.apply()` 不可）。
- 0011: `fetchMock` が pool-workers 0.13.0 で撤去済みで `vi.spyOn` が公式代替、retry backoff 実時間が sandbox で観測不能。
- 0016: Queue の `contentType` デフォルトが `"json"`（Context7 で確認済み）、tail の型が単数→配列に変更。
- 0017: conformance oracle は host 実行の dev-only package、golden はバイト比較。
- 0020 / 0021（新規2ファイル）: 追補なしの新規承認済み ADR。3重ループ検証サイクル・GHC2024 統一。判断要素なし（新規承認の事実として認識するのみ）。
- README: 新規 ADR 3件（0019/0020/0021）を索引テーブルへ追記しただけ。判断不要。

---

## ファイル別詳細

### 0002-wasi-reactor-workerd-integration.md（M）

**追補 (2026-07-22): WASI shim の選定変更**

- 見出し/要旨: `@cloudflare/workers-wasi` は reactor ABI の `initialize()` 未対応（2022年以降実質未保守）と判明したため、`@bjorn3/browser_wasi_shim`（`^0.4.2`）へ採用変更。
- foot-gun記録（判断不要）: `{debug: false}` を明示しないと WASI syscall が全て stdout に漏れる（実測）。
- **判断要**: 選択肢2（自前最小 shim）への移行は依然 open のフォローアップ（上記一覧 #8）。

### 0003-jsffi-cloudflare-bindings-layer.md（M）

**追補 (2026-07-23): JSFFI 境界の実装規約 (A1-A3 実機確定)**

- 決定1（★重要）: `try @JSException` は bare `safe` import の Promise reject を捕捉できない（GHC 9.12.4 実機確認）。throw しうる JS メソッドは JS 側 try/catch 封筒（`{ok, value}` / `{ok:false, message}`）で包む。**この制約は A4 以降全 binding I/O 実装に適用必須**と明記。
- 決定2: safe/unsafe の割当は対象 JS API の Promise 性で機械的に決定。pending Promise 自体を値として受け取る場合は非 thenable envelope で包む。
- 決定3: `Internal.FFI.X` は対応する `Binding.X` を import しない（循環回避）、モジュール間ヘルパ共有もしない。
- 決定4: `JSString` は FFI 境界を越えられない（実測でコンパイル不能）。文字列は Bytes bridge + TextEncoder/TextDecoder 経由。
- 決定5: ArrayBuffer 系は Uint8Array view 化 + 二段 null 判定。null 判定の厳密さは API 毎に異なる（D1 は `=== null` 厳密、KV/R2 は nullish 許容）。
- 決定6: `_probe*` foreign export は `examples/quickstart` 限定（dead-code-elimination対象外のため）。macrotask yield（`setTimeout(...,0)`）がテストハーネス側で必要（ライブラリ実装の問題ではない）。
- **判断要素なし**（すべて実機検証済みの確定事項として記録）。

### 0006-servant-execution-engine.md（M）

**追補 (2026-07-22): 実装確定事項 — 移植方式・conformance 境界・documented extensions**

- 実装方式: `servant-server` 0.20.3.0 の `Router'`/`RouteResult`/`DelayedIO`/`Delayed` をソース移植（BSD-3 attribution 保持、`build-depends` には追加しない）。
- conformance 境界: status（常時）+ Content-Type（charset込み）+ 成功(2xx) body のみ比較。**エラー body は比較除外**。
- documented extensions（意図的差異）: (a) 405 に `Allow` ヘッダ生成、(b) エラー本文は JSON エンベロープ既定 + Accept ネゴシエーションで text/plain フォールバック、(c) `ReqBody` byte-limit超過は413。
- 実測意味論記録: `Capture` 解析失敗は回復可能な400（404ではない）、`Header`(Optional)欠落はNothing、path処理はsplit→decode順、PlainTextのAcceptはcharset=utf-8限定。
- **判断要素なし**（承認済み確定事項）。

### 0008-cloudflare-platform-bindings.md（M）

2つの追補ブロックが同一ファイル内に存在（A3分・A4分）。

**追補 (2026-07-23): KV/D1/R2 実装で確定した設計（A3分）**

- 決定1: binding配線は型レベルfold + env構築時（per-request）の全数検証。「起動時検証」= per-requestのBindingEnv構築時と再解釈。
- 決定2: handle型はCPP二分岐（wasm32ではnewtype JSVal、hostではSTUB）— ただし後述0019 07-24追補でこの広範なCPP方針自体が是正対象になっている点に注意。
- 決定3: options引数はincremental object build方式に統一。
- 決定4: KV/R2のlist結果は実APIのページネーション判別共用体を忠実再現（フラットリストは不採用）。
- 決定5: D1 row decodeはJS側構造walk（`aeson`不採用、SQLite型情報保持のため）。
- 決定6: D1エラーはthrow、`success`フラグはエラー検出手段として扱ってはならない（substringマッチで分類）。
- 決定7: R2 getは3値返却（NotFound/PreconditionFailed/Success）、body はreader closure + 生stream handleの両建て。
- **決定8（★訂正あり、上記一覧#6参照）**: timestamp/サイズは絶対値=`Integer`・相対値/件数=`Int`の使い分けに訂正。reviewer iter2で `D1Meta` 3フィールドのFFI境界自体が`IO Int`のままだった追加バグを発見・修正。
- 実測記録: R2バケット名はハイフンのみ許可（アンダースコア不可）、`onlyIf`は bare形式必須（quoted だと例外）、R2 getのcondition不一致はreject せずresolve。

**追補 (2026-07-23): A4で確定した dos slot / DO storage / doFetch・serviceFetch のURL再構成**

- 決定1: `dos` slot実体化（`getDurableObjectNamespace` + 型族 + 別class `BuildDosEnv` + 起動時`BindingMissingError`再利用）。`BindingEnv`のランタイム表現が2マップへbreaking変更（公開シグネチャは不変）。
- 決定2: DO storageはKVスタイルAPI + transactionは操作リスト一括適用（**Haskellクロージャをtxnコールバックに渡さない設計判断、A4 planの明示的裁定**）。値はstructured-clonable Uint8Array主。rollback実挙動を実DO instanceで検証済み。
- 決定3: `doFetch`/`serviceFetch`のURL再構成 = placeholder + path + query（`urlQueryRaw`、new）。**非可逆2点**（キー昇順レンダリングで元順序非保持、再パーセントエンコーディングなし）をHaddockに明記済み。
- 実測記録: RPC stubはProxy-backedで`.apply()`不可・spread-call必須、自己参照Service Bindingは補助Worker無しで解決可、非WorkerEntrypointへのRPCは区別可能なエラー。

### 0009-auth-zero-trust-subtlecrypto.md（M）

**追補 (2026-07-23): Phase A theme A5 で確定した Access JWT 検証パイプライン・SubtleCrypto 実装**

- 決定1: 検証パイプライン確定形（alg allowlist先行拒否→JWKS取得→CryptoKey生成→署名検証→claim検証）。**全失敗は一律不透明401**に潰す（研究側提案の401/403分離は不採用）。診断はexception constructor名のみログ出力。
- **決定2（上記一覧#1、要確認）**: JWKSキャッシュが本文(KV/Cache)からIORef実装へ変更。
- 決定3: `AccessVerifierOptions`（clock skew/JWKS TTL/issuer override）。`accessVerifierOptionsExpectedIssuer`は**lihsの明示裁定**による追加フィールド（「YAGNIだから不要」を明示的に却下）。`accessConfigTeamDomain`は短縮チーム名のみという意味論も確定（A5 batch3のドラフトは逆前提で実装しておりbatch4で是正）。
- 決定4: JWKS取得はADR-0011の自前client（`clientIn`）を使用。
- 実測記録: `crypto.subtle.verify`は署名不一致でreject せずfalseを返す（→ワーカーサンプルにサイレント全数検証失敗のバグを誘発しうる実測）。RE実測でAUD誤り→401、正AUDで200を確認（実署名検証通過の実証）。Miniflareローカルのプレースホルダidが実wrangler deployでcode 10042拒否。
- **本文乖離記録（上記一覧#3、要確認）**: 「servantコアのAuthProtectを用い」という本文記述は実態と異なる。
- **残課題（上記一覧#2、要確認）**: Service Token(M2M)非対応、unknown-kid再取得にnegative cacheなし、構造化ログ化はA6送り、**KV durability open finding（POST 200後にKV keyが見つからない、A8最優先調査へ昇格）**。

### 0010-websockets-durable-objects.md（M）

**追補 (2026-07-23): Phase A theme A4 で確定した DO WebSocket hibernation 実装**

- 決定1: hibernation APIを主実装とし standard accept()は不実装（**転換、lihs承認 2026-07-23**）。課金モデル（duration billing回避）とCloudflare推奨が根拠。DOクラスのfetchとwebSocketMessage/Closeが同一wasmExportsインスタンスを共有することを実機実証（一発GREEN）。
- 決定2: `WebSocketMessagePayload`型（旧`WebSocketIncomingMessage`からrename）。実測footgun: ローカルharnessのbinaryTypeデフォルトが"blob"のため明示`"arraybuffer"`設定が必要。
- **決定3（上記一覧#7、要確認）**: servant WebSocket combinator自体はA4スコープでは未実装のまま。
- 実測記録: ローカルharnessでclient側closeイベントが発火しない（bounded pollで代替確立、時間凍結artifactの3例目）。

### 0011-outbound-http-fetch-backend.md（M）

**追補 (2026-07-23): Phase A theme A4b で確定した servant-client-core 再利用方式・RunClient バックエンド実装**

- 決定1: instance導出はreal `servant-client-core`の`HasClient`/`clientIn`を直接再利用（並行class `HasWorkerClient`は完全削除、研究3体+synthesizer経由のorchestrator裁定★B案）。
- 決定2: `FetchClient`/`FetchClientOptions`確定形。タイムアウトは`AbortController`+手動`setTimeout`（`AbortSignal.timeout()`はworkerd実行時バグのため不採用、`controller.abort()`は引数なしで呼ぶ注意）。
- 決定3: retry意味論 — 冪等メソッド限定 + timeout/network系のみ、subrequest-limit超過と非2xxはretryしない。
- 決定4: エラー分類はFetchTransportErrorをConnectionErrorに包む。subrequest-limit判定は正規表現ベストエフォートマッチ（プラットフォーム文言変更に脆弱と明記）。
- 決定5: conformance oracleは`Servant.Client.Free`でhost上純粋inspect。Toy APIで8/8一発GREEN（19 branch全網羅は不要という裁定の厳密解釈）。
- 実測記録: `fetchMock`がpool-workers 0.13.0で撤去済み、公式代替は`vi.spyOn`（`afterEach(vi.restoreAllMocks())`必須）。retry backoffの実時間はsandboxで観測不能。
- 中立フォローアップ: `RequestBodySource`（送信ストリーミング）は未充足のままA7送り。cf property/キャッシュ制御の露出、Service Bindings RPCとfetchの統一抽象は未決のまま。

### 0012-middleware-equivalents.md（M）

**追補 (2026-07-24): A6 で plan確定した Tier1/Tier2 ミドルウェア構成・適用順序** + **実装確認 (2026-07-24, batch A6-6 U13)**

- 決定1: `Middleware env = FetchHandler env -> FetchHandler env`（direct-style、WAI由来CPSは不採用）。標準セットはwithRequestId/withStructuredLoggingの2つ、Tier1（cloudflare-workersパッケージ、servant非依存）配置。
- 決定2: 適用順序表（1.withRequestId→2.withStructuredLogging(try-log-rethrow)→3.handler opt-in変換→4.mkFetchHandler既存tryの最終防波堤）。
- 決定3: typed例外→ServerError変換はservant-cloudflare-workers側（Tier2）、依存方向逆転回避のため。既定500維持・ルート単位opt-in override。
- 決定4: CORS/セキュリティヘッダはA6非スコープ、rate limit/WAFエッジ委譲は無変更。
- 決定5: `mkFetchHandler`への標準wiring内蔵は見送り（凍結surface不変原則）。
- **実装確認セクション**: 決定1-5すべて実コードと**「差分: なし」**。

### 0013-observability.md（M）

**追補 (2026-07-24): A6 で plan確定した構造化ロガー・request id・error taxonomy** + **実装確認 (2026-07-24, batch A6-6 U13)**

- 決定1: 構造化ログ=単一JSON objectを`console.log`に渡す（文字列連結禁止、Workers Logs自動インデックスの前提）。
- 決定2: `tailLog`は下位primitiveとしてsignature不変のまま存置（構造化ロガーは追加API、置換ではない）。
- 決定3: request id = cf-ray継承 + `crypto.randomUUID` fallback。Handlerからの直読はスコープ外。
- 決定4: durationはplatform公表Wall/CPU timeが一次ソース、`Date.now`差分は相関用best-effort。
- 決定5: error levelはsampleRateに関係なく常時emit。
- 決定6: `LogSink`/`deferredSink`は型のみ（外部APM送信実装はスコープ外）。
- 決定7: lint gate `scripts/verify-console-boundary.sh`新設（`console.*`直接呼び出しは`Internal/FFI/Reactor.hs`のみ許可）。
- 決定8: 256KB/reqログ予算・Free plan制限を設計制約として記録。
- 決定9: error taxonomy 10型確定（umbrella型なし）。`KVError`/`R2Error`は呼び出しサイト分類方式で新設。封筒化の全面化（KV/R2全メソッド・d1All/d1First）はStep0実験結果に関わらず確定。
- **実装確認セクション**: 決定2-9は一致。**決定1のみ「差分あり」**（上記一覧#4）。

### 0016-non-fetch-entrypoints.md（M）

**追補 (2026-07-23): Phase A theme A4 で確定した非fetchエントリポイントの実装**

- 決定1: `mkScheduledHandler`/`mkQueueHandler`/`mkTailHandler`の確定シグネチャ（JSVal×3 + BuildBindingEnv/BuildDosEnv制約）。scheduled/queueは意図的に`try`を持たず例外をそのまま伝播（プラットフォームのretry意味論を利用）。`fetch/queue/scheduled/tail`の4 handlerが完成（`email`は対象外・follow-up継続）。
- 決定2: `ScheduledEvent`→`ScheduledController`へ再設計（`scheduledTime`は素のJS numberで届くとハーネスソース直読で確定）。
- 決定3: `QueueMessage`record + ackAll/retryAll + `QueueContentType`判別共用体。デフォルトcontentTypeは常に`"bytes"`に解決（プラットフォームのjsonデフォルトには任せない設計）。dedupヘルパはbest-effort（厳密exactly-onceではない）。
- 決定4: Tailは配列型`[TailEvent]`へ変更（旧単数形は誤りと訂正）。フィールドは最小3個に留める意図的判断。
- 決定5: DO entrypointはJS glue classへの委譲、Haskell側はstateless。RPC stubがspread-call必須という実測footgun。
- 決定6: 絶対時刻Integer/相対値Intの型規約（ADR-0008追補への準拠）。
- 実測記録: リンカフラグ不要、自己参照Service Bindingが補助Worker無しで解決可、ローカルharnessでQueue producer→consumer自動配信が観測不能（wrangler devにも代替経路なし、2つの独立否定確認）。
- **判断要素なし**（実装完了済みの確定事項として記録）。

### 0017-testing-strategy.md（M）

**追補 (2026-07-22): vanilla GHC ビルドの互換手段変更 + conformance oracle の実装**

- 決定1: vanilla GHC互換手段を`ghc-wasm-compat`相当のシムから、cabal `if os(wasi)` + ソース内CPPへ置き換え（ADR-0019追補に従属）。
- 決定2: tier3 conformanceの実装形態確定 — 実servant-server 0.20.3.0をdev-only package `conformance-oracle`でhost実行しgolden(50ケース)を生成・commit。出荷側test-suiteはservant-server非依存のままバイト比較のみ。
- **判断要素なし**（ADR-0019/0006追補と整合した確定事項）。

### README.md（M）

- 新規ADR 3件（0019/0020/0021）を索引テーブルへ追記しただけ。タイトル・ステータス列とも各ADR本文と一致確認済み。**判断要素なし**。

### 0019-monorepo-package-layout.md（??新規）

本文（4パッケージ分割の骨格決定）+ 2つの追補（07-22, 07-24）が一体で新規ファイルとして初出。

- 本文: `cloudflare-workers`（基盤/leaf）/ `servant-cloudflare-workers`（server）/ `servant-cloudflare-workers-client`（client）/ `servant-cloudflare-workers-access`（auth）の4パッケージへ分割。root直下フラット配置（`servant`本家の慣行に一致、`packages/`集約は不採用）。名前空間は複数形`Workers`統一。安定façadeと`*.Internal.*`の2層API。単一examples（`examples/quickstart`）がtier2統合fixture兼用。単一`src`ツリー + 並行`hs-source-dirs`不採用の原則。
- **テスト構成節（上記一覧#10、要確認）**: ADR-0017の三層テスト分類の物理配置への初回解釈（tier1=各パッケージunit、tier3=serverパッケージcompat、tier2=examples/quickstart統合）。
- **追補 (2026-07-22)**: stock GHC型検査は`ghc-wasm-compat`不使用、cabal `if os(wasi)` + ソース内CPP方式へ。`Internal/FFI/*`隔離の適用範囲は公開4パッケージ限定（`examples/quickstart`は対象外）。移植コードのBSD-3 attribution。
- **追補 (2026-07-24)（上記一覧#5、要確認・重要）**: 「spike移行裁定」— 07-22追補のCPP方式がpublic/productionモジュールにまで広がった逸脱を、lihsが2026-07-24 grill（E-Q13）で裁定し、自前vendored module（`data JSVal`のみ~10行）による host型シムへ回帰する方針に確定。CPPは`Internal/FFI/*`限定に縮退。**配置（internal sublibrary か共有packageか）はA6bで実装者が確定、本追補時点では未着手**。移行タイミングはA6 close直後・A7着手前の独立theme A6b。既存コース（cloudflare-workers-hs-build、84章）との構造乖離はPhase Bのコース更新で「進化」narrativeとして吸収予定、既存章の逐次書き換えは対象外。

### 0020-cloudflare-verification-cycle.md（??新規）

- 追補なし、新規承認済みADR。3重ネストループ（dev inner / CI / release）+ 宣言止まりだったsmokeの実行化を決定。assertion 1-8はローカル（Miniflare/workerd）充足、9-13（実受理・実コールドスタート・実Access・実Cron/Queues・実Logs到達）は実エッジ必須と明確に切り分け。release loopはrepo variable + Cloudflare secretのopt-inでゲート、未設定repo/forkはskip。サイズは圧縮前64MB blocking / 圧縮後10MiB budget・3MiB warn。性能は`ci/perf-budget.yml`のbaseline比で回帰判定。
- **判断要素なし**（新規承認事実として記録するのみ、遵守事項チェックリスト8項目あり）。

### 0021-language-edition-ghc2024.md（??新規）

- 追補なし、新規承認済みADR。全パッケージ（4パッケージ+examples/quickstart+dev-only conformance-oracle）の`default-language`を`GHC2021`から`GHC2024`へ統一。理由はupstream(konn系)との言語版一致 + `default-extensions`重複削除。`MonoLocalBinds`による局所束縛の多相推論制限というトレードオフを明記、実測では既存コードへの型注釈追加ゼロで通過。
- 中立フォローアップ: 教材側（pschoolコース）は`GHC2021`前提のままで乖離が生じる旨を記録（本ADRは事実記録のみ、教材更新は別途）。
- **判断要素なし**（新規承認事実として記録するのみ）。

# ADR-0009: 認証は Cloudflare Zero Trust (Access) を一級に活用し、暗号は SubtleCrypto に委譲する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0011](./0011-outbound-http-fetch-backend.md)

## 背景と課題 (Context)

実運用では認証が必須である。Haskell の標準的な認証手段（`servant-auth` / JWT）は
`crypton`/`cryptonite` 暗号エコシステムに依存するが、**これらは GHC WASM バックエンドでビルドできない**
（検証済み）。一方で Cloudflare には **Zero Trust (Cloudflare Access)** があり、エッジで認証を完結させ、
検証済み ID を署名付き JWT として Worker に渡す。さらに Workers ランタイムは標準の **SubtleCrypto
(Web Crypto API)** を提供する。

**本プロジェクトの方針は「認証は Cloudflare Zero Trust を最大限活用できるライブラリにする」**こと。
したがって本ライブラリの第一級の認証は、自前で暗号を実装することではなく、**Cloudflare Access による
エッジ認証を信頼し、その表明 (assertion) を検証して Servant ハンドラへ型付き ID として届ける**ことに置く。

### Cloudflare Access の要点

- 認証済みリクエストには JWT が `Cf-Access-Jwt-Assertion` ヘッダ（および `CF_Authorization` Cookie）で付与される。
- 検証鍵はチームの JWKS エンドポイント `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` で公開される。
- 検証では署名（RS256）に加え、`aud`（Access アプリケーションの Audience タグ）・`iss`・`exp` 等を確認する。
- 機械間 (M2M) は **Service Token**（`CF-Access-Client-Id` / `CF-Access-Client-Secret`）で認証できる。

## 決定要因 (Decision Drivers)

- Zero Trust を最大限活用し、認証の重い処理をエッジへオフロードできること
- `crypton`/`cryptonite` を使わずに署名検証を実現できること
- 検証済み ID（メール・グループ等のクレーム）を Servant ハンドラへ型付きで渡せること
- 対話ユーザ認証と Service Token（M2M）の双方を扱えること

## 検討した選択肢 (Considered Options)

1. **Cloudflare Access を一級にし、Access JWT を SubtleCrypto で検証して ID を文脈注入する。アプリ独自 JWT は副系として SubtleCrypto で扱う**
2. `crypton`/`cryptonite` ベースの `servant-auth` をそのまま使う
3. Haskell 純粋実装の暗号ライブラリで JWT 検証を自前実装する

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- **第一級: Cloudflare Access (Zero Trust)。** `Cf-Access-Jwt-Assertion` の JWT を検証する。
  検証手順は (a) JWKS（`/cdn-cgi/access/certs`）取得（[ADR-0011](./0011-outbound-http-fetch-backend.md) の fetch、結果は KV/Cache でキャッシュ）、
  (b) **SubtleCrypto**（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) 経由の JSFFI）で RS256 署名を検証、
  (c) `aud`/`iss`/`exp` 等のクレーム検証。検証済みの ID（メール、`sub`、Access グループ等）を
  型付きの「認証主体 (Identity)」として表現する。
- Servant 統合は `servant` コアの `AuthProtect`（純 Haskell、再利用可）を用い、本ライブラリの
  サーバ解釈系（[ADR-0006](./0006-servant-execution-engine.md)）が Access 検証ハンドラを実行して
  Identity をハンドラ文脈へ注入する。専用組み合わせ子（例: `CloudflareAccess`）も提供する。
- **Service Token (M2M)** も Access の枠組みで扱い、対話ユーザと同じ Identity 抽象に正規化する。
- **副系: アプリ独自 JWT。** Access を使わない経路向けに、JWT の署名生成/検証を SubtleCrypto で行う
  簡易実装を提供する（`crypton` は使わない）。乱数は Workers の `crypto.getRandomValues` /
  WASI `random_get` を用いる。
- TLS は送信時にランタイムが担うため、Haskell 側に TLS スタックを持たない（[ADR-0011](./0011-outbound-http-fetch-backend.md)）。

## 結果 (Consequences)

### 良い結果 (Positive)

- 認証をエッジ（Access）へオフロードでき、Worker 内の暗号処理を署名検証に限定できる。
- `crypton`/`cryptonite` のビルド不能問題を回避できる。
- 対話ユーザと Service Token を単一の Identity 抽象で扱え、ハンドラ実装が簡潔になる。
- Access のグループ/ポリシーを認可に活用でき、Zero Trust の機能を最大限引き出せる。

### 悪い結果・トレードオフ (Negative)

- Access を前提に最適化するため、Access を使わない構成では副系（独自 JWT）に頼ることになる。
- SubtleCrypto 依存により、対応アルゴリズムは Web Crypto がサポートする範囲（RS256/ES256 等）に制限される。
- JWKS 取得のレイテンシ・鍵ローテーションに備えたキャッシュ/失効戦略が必要。

### 中立・フォローアップ (Neutral / Follow-up)

- JWKS キャッシュの TTL・鍵ローテーション時の再取得方針を定める（KV/Cache 利用）。
- `aud`（Application Audience）・許可するチームドメイン等は設定（Secrets/Vars: [ADR-0008](./0008-cloudflare-platform-bindings.md)）で与える。
- 認可（Access グループ → ロール対応）の表現を Servant 組み合わせ子としてどう出すか詳細化する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### Cloudflare Access 一級 + SubtleCrypto 検証

- 利点: 方針に合致、`crypton` 回避、エッジ認証活用、M2M 統一。
- 欠点: Access 前提への最適化、アルゴリズムは Web Crypto 範囲、JWKS キャッシュ運用が必要。

### `crypton`/`cryptonite` ベースの `servant-auth`

- 利点: 既存実装をそのまま使える。
- 欠点: **WASM バックエンドでビルド不能**。採用不可。

### 純 Haskell 暗号で自前 JWT 検証

- 利点: 外部 API に依存しない。
- 欠点: 署名検証を純 Haskell で実装・監査するコストとリスクが高い。Zero Trust 活用方針からも外れ、
  SubtleCrypto があるのに利点が乏しい。

## 遵守事項 (Compliance)

- [ ] `crypton`/`cryptonite` へ依存しない。
- [ ] 署名検証・乱数は SubtleCrypto / `crypto.getRandomValues`（WASI `random_get`）を用いる。
- [ ] Access JWT は署名・`aud`・`iss`・`exp` を検証してから ID を信頼する（検証前のクレームを認可に使わない）。
- [ ] JWKS は取得結果をキャッシュし、鍵ローテーションに追従する。

## 参考資料 (References)

- Haskell Discourse — Blog system on Cloudflare Workers（crypton 不可・SubtleCrypto・Zero Trust 併用）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- GHC User's Guide — WebAssembly backend（JSFFI で Web API を呼ぶ）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Cloudflare — Announcing WASI on Workers（Workers の標準 Web API 提供）: https://blog.cloudflare.com/announcing-wasi-on-workers/

## 追補 (2026-07-23): Phase A theme A5 で確定した Access JWT 検証パイプライン・SubtleCrypto 実装

- ステータス: 承認（追補）
- 日付: 2026-07-23
- 決定者: lihs

Phase A theme A5（`servant-cloudflare-workers-access` の最後の stub 面 = `verifyAccessJWT` 本体を実装、
A2 close 時点で明示的に残していた open item、本 ADR の完了条件）で確定した設計を記録する。研究 3 体の
報告が強く収束したため synthesizer を省略し orchestrator が直接裁定した（逸脱として記録済み）。本文
自体は書き換えない。

### 決定 1: 検証パイプラインの確定形

`verifyAccessJWT`（= `verifyAccessJWTWithOptions defaultAccessVerifierOptions` の薄いラッパ）は次の順に
実行する: (1) JWT を `.` で 3 分割（`jwtParts`、分割数が異なれば即 malformed）、(2) ヘッダの `alg` を
`RS256` ホワイトリストで検査 — **SubtleCrypto に到達する前に拒否**する（alg-confusion・`alg: none` 攻撃
への対策）、(3) JWKS を取得し `kid` に一致する鍵を探索、(4) `subtleImportKey` で `CryptoKey` を生成、
(5) 署名セグメントを base64url decode し、RFC 7515 §5.1 の signing input（`header.payload`）を組んで
`subtleVerify`、(6) クレーム検証（`exp`/`nbf` は skew 設定可・default 0、`aud` は配列/string 双方を
正規化してメンバーシップ判定、`iss` は導出値または override と厳密一致）。ヘッダ解析・JWKS 探索の
`Either` 失敗と SubtleCrypto 例外・想定外例外はすべて単一の `try @SomeException` を通り、**全失敗は
一律不透明 401** に潰す（研究側が提案した 401/403 分離案は不採用）。診断は例外の **constructor 名のみ**
を `Cloudflare.Workers.Observability.tailLog` へ 1 行出力する（攻撃者が制御できる生の JWT 文字列や
JSON パースエラーメッセージをログへ含めない）。構造化ログ化は A6 へ送付。

### 決定 2: JWKS キャッシュは isolate-lifetime `NOINLINE IORef`（capacity=1）に確定 — 本文からの変更

本文「決定」節は JWKS 取得結果を「KV/Cache でキャッシュ」すると述べていたが、**実装は isolate の生存期間
に閉じた `NOINLINE IORef`（保持は直近 1 URL のみ、`kid` ミス時は即時再取得、ヒットしなければ replace）**
に確定する。根拠: (a) 本ライブラリは単一 team を前提としており cross-isolate 共有の必要性が薄い、
(b) KV/Cache API を経由しない分だけ依存が最小になる、(c) Cloudflare Access の鍵ローテーション（6 週周期
+7 日 grace）には `kid` ミス即時再取得で追従でき、TTL（default 1 時間）による定期更新と合わせて十分、
(d) RE 実測（後述）で KV 書き込みの可視性に未解決の疑義が見つかっており、認証のクリティカルパスを KV の
実環境挙動に依存させるリスクを避けられる。並行 fetch 間の排他は行わない（冪等 GET の二重化は無害という
判断）。KV/Cache は cross-isolate 最適化の将来オプションとして選択肢に残すが、現状の実装では使わない。

### 決定 3: `AccessVerifierOptions` — clock skew・JWKS TTL・issuer override

```haskell
data AccessVerifierOptions = AccessVerifierOptions
  { accessVerifierOptionsClockSkewSeconds    :: Integer
  , accessVerifierOptionsJWKSCacheTtlSeconds :: Integer
  , accessVerifierOptionsExpectedIssuer      :: Maybe Text
  }

defaultAccessVerifierOptions :: AccessVerifierOptions
defaultAccessVerifierOptions = AccessVerifierOptions
  { accessVerifierOptionsClockSkewSeconds    = 0     -- Cloudflare 公式サンプル parity
  , accessVerifierOptionsJWKSCacheTtlSeconds = 3600  -- 1h
  , accessVerifierOptionsExpectedIssuer      = Nothing
  }
```

`accessConfigTeamDomain`（`AccessConfig` の既存フィールド）は **短縮チーム名のみ**（例:
`"acme-team"`、RE では `"lihs"`）であり、`*.cloudflareaccess.com` を含む完全ドメインではないという
意味論に確定した（A5 batch 3 のドラフトは逆の前提で実装しており、course ch-07 の worked example の
慣例と照合して batch 4 で是正 — 実 JWT を誤った導出で検証する前に発覚）。`.cloudflareaccess.com` の
付与はライブラリ内部（`"https://" <> accessConfigTeamDomain <> ".cloudflareaccess.com"`）で行う。

`accessVerifierOptionsExpectedIssuer :: Maybe Text` は a5-plan の当初裁定リストにはなかった **lihs の
明示裁定**による追加フィールドである: `iss` の `https://<team>.cloudflareaccess.com` という形式は
Haskell 側の不変条件ではなく **Cloudflare 側のプラットフォーム契約**であり、その導出をハードコードした
まま恒久的な override 手段を持たないのは production ライブラリとして不十分と判断した（「YAGNI だから
不要」という主張を明示的に却下 — Cloudflare 公式の検証サンプル自体も issuer 全体を設定値として持たせて
いる）。`Nothing` は既存の導出挙動を維持し、`Just` は導出を一切行わず値をそのまま使う。

### 決定 4: JWKS 取得は ADR-0011 の自前 client（`clientIn`）を使用

`Internal.JWKS.JWKSApi = Get '[JSON] JWKSDocument` という **ゼロセグメントの `HasClient` API 型**を、
`AccessConfig` の `accessConfigJWKSUrl`（`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` 相当）
をそのまま `BaseUrl` として `parseBaseUrl` に渡し、`clientIn`/`FetchClient`（[ADR-0011](./0011-outbound-http-fetch-backend.md)
追補の決定 1「`HasClient`/`clientIn` の直接再利用」）で dispatch する。ゼロセグメントの API 型でも
`parseBaseUrl` が `baseUrlPath` を保持し、元 URL どおりにリクエストが送られることを実装前に実証済み
（仮定で進めていない）。本文が「JWKS 取得は ADR-0011 の fetch」とだけ述べていた方針を、パッケージを
またいだ実装として初めて具体化した。

### 実測で確定した挙動

- **`crypto.subtle.verify` は署名不一致で `reject` せず `false` を返す**（実機確認）。この挙動により、
  ch-07-03 向けの worked example ドラフトが署名セグメントを base64url decode せず `subtleVerify` に渡す
  バグ（さらに `subtleVerify` の引数順が入れ替わっている等の複数バグを含む）が、型検査もテストも素通り
  し得る **サイレントな全数検証失敗**になり得ることが判明した。当該バグは Phase B の lecture patch 対象
  として divergence-notes に記録済みで、実装（`Access.hs`）自体は正しい順序で decode してから渡す。
- `base64-bytestring` の `bytestring < 0.12` 制約は Hackage revision で緩和済みであり、wasm 側の依存
  解決はフォールバックなしで通った（`Data.ByteString.Base64.URL.decodeUnpadded` のリンク成功まで確認）。
- **RE 実測（実 Cloudflare Access 越しの本番デプロイ）**: 旧候補 AUD のまま実 Access ログインを通すと
  `AccessErrorAudienceMismatch` による 401 を観測 — これは実署名検証を通過した上での `aud` 拒否であり、
  実 Cloudflare 発行 JWT が SubtleCrypto 検証まで正しく到達し署名検証が成功したことの実証でもある。正しい
  AUD へ redeploy した後は 200（`{"adminStatsTotalShortenedUrlCount":0}`）を観測。未認証アクセスは
  `ZeroTrust` combinator を持たない `/shorten` を含めアプリケーション（hostname）単位で edge 302 リダイ
  レクトされる ── Access の保護境界は型レベルの `ZeroTrust` combinator の粒度とは独立している。
- Miniflare 専用のプレースホルダ id（`wrangler.toml` の `id = "url_shortener_kv_local"` 等）は実
  `wrangler deploy` で **code 10042** により拒否される（Miniflare のローカル名前解決では素通りする）。

### 本文の「`servant` コアの `AuthProtect` を用い」の実態

本文「決定」節は Servant 統合について「`servant` コアの `AuthProtect`（純 Haskell、再利用可）を用い」
と述べていたが、**実装は `AuthProtect` を移植・再利用していない**。A2 Unit 7 で確立した `ZeroTrust`
（空のマーカー型）/`AccessVerifier`（`Context` 経由で注入する `Text -> IO (Either AccessError AccessClaims)`）
の単相 combinator を A5 でも変更せず使い続けている。認証チェックの差し込みは real `servant-server` の
`BasicAuth` インスタンスが使うスケジューリングスロット（`addAuthCheck`）と同じ箇所を利用するが、これは
最も近い upstream のアナロジーというだけであり、Cloudflare Access 自体に対応する servant コアの
combinator は存在しない。A5 で stub から real になったのは `AccessVerifier` に差し込む関数（`verifyAccessJWT`）
の中身のみで、combinator 自体は無変更である。本文の表現は実装の実態と食い違うため、ここに注記する
（本文自体は書き換えない）。

### 残課題 (Remaining)

- **Service Token (M2M) は非対応**。A5 のスコープは対話ユーザ（Access セッション）トークンのみで、
  `CF-Access-Client-Id`/`CF-Access-Client-Secret` の検証経路は未実装。対応方針は A6/A8 で検討する。
- **unknown-`kid` 時の再取得に negative cache がない**。現状は miss のたびに `fetchAction` を呼ぶ
  （冪等 GET の重複は許容という判断）。悪意ある大量の unknown-`kid` リクエストへの対策は A6/A8 で検討。
- **構造化ログ化**は A6 へ送付。現状は例外 constructor 名のみの `tailLog` 1 行。
- **KV durability の open finding**: RE 実測で `POST /shorten` が 200 を返した後、対応する KV key が
  実 namespace の `list`/`get` いずれからも見つからなかった（60 秒超待機後も再現）。`kvPut` の Promise
  は解決しており書き込み呼び出し自体は行われているが、その書き込みが実際に永続化されたかは RE Unit の
  ツールからは直接観測できていない。**A8 の real edge E2E で最優先の調査事項に昇格**する。

### 参考資料（追補分）

- [ADR-0011](./0011-outbound-http-fetch-backend.md) 追補（`HasClient`/`clientIn` 再利用方式 — 本追補の
  決定 4 が使う具体的機構）
- [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) 追補（JSFFI 境界の実装規約 — SubtleCrypto FFI
  封筒もこの規約に従う）
- 実装詳細・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a5-plan.md`、
  `a5-re-memo.md`、`_phase_b/divergence-notes.md`「A5」節、`API-LEDGER.md` item 14（"A5 close"）

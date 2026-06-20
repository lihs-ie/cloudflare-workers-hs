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

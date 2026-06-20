# ADR-0011: 送信 HTTP は fetch をバックエンドとする servant-client 解釈系を自前実装する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)

## 背景と課題 (Context)

実運用では外部 API 呼び出し（送信 HTTP）が要る。JWKS 取得（[ADR-0009](./0009-auth-zero-trust-subtlecrypto.md)）、
オリジン取得、外部サービス連携などである。標準的な `servant-client` は `http-client` を介し、
`http-client` は `network`（ソケット）に依存するため **`wasm32-wasi` でビルドできない**。WASI の
`sock_*` は `ENOSYS` で、そもそもソケットを開けない。一方 Workers では JS の **`fetch` API** が送信
HTTP を担い、TLS もランタイムが処理する。

本プロジェクトは自前実装方針のため、送信経路も外部ライブラリに依存せず、`fetch` をバックエンドとする
クライアント解釈系を自前で実装する。

## 決定要因 (Decision Drivers)

- ソケット不可（`ENOSYS`）の制約下で送信 HTTP を実現すること
- `servant-client` の型レベル API 記述を再利用できること（型共有・DRY）
- async JSFFI（Promise/`await`）で `fetch` を扱えること
- TLS をランタイムへ委譲し、Haskell に TLS スタックを持ち込まないこと

## 検討した選択肢 (Considered Options)

1. **`servant-client-core`（純 Haskell）を再利用し、`fetch` を呼ぶ `RunClient` バックエンドを自前実装する**
2. `servant-client` + `http-client` をそのまま使う
3. 送信を都度 JSFFI で `fetch` 直書きし、型付きクライアント抽象を設けない

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- `servant-client-core`（`network` 非依存・純 Haskell）を再利用し、その `RunClient` 抽象に対する
  バックエンドを、JSFFI（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）の `fetch`/`Request`/`Response` で
  自前実装する。これにより API 型から送信クライアントを導出でき、サーバ側（[ADR-0006](./0006-servant-execution-engine.md)）と型を共有できる。
- リクエスト本文・ヘッダ・メソッド・クエリを `fetch` の `Request` へ写し、応答を `Response` から読み出す。
  本文はストリーミング（[ADR-0007](./0007-streaming-readablestream.md)）を尊重する。
- **TLS はランタイムが担う**ため、Haskell 側に TLS 実装を持たない。
- 既存の `servant-client-fetch`（Fetch API を JSFFI で backend にする先行例）は **設計参照のみ**とし依存しない。
- Service Bindings 経由の Worker 間呼び出し（[ADR-0008](./0008-cloudflare-platform-bindings.md)）も、同じ
  クライアント抽象から扱えるよう整合させる。
- **タイムアウト/リトライ/中断**: `fetch` には `AbortSignal` ベースのタイムアウトを既定で付与し、リトライは
  **冪等メソッドに限定**して指数バックオフを適用する。サブリクエスト上限（無料 50/リクエスト、
  [ADR-0014](./0014-bundle-size-limits-performance.md)）の超過は専用エラー型で表す。

## 結果 (Consequences)

### 良い結果 (Positive)

- ソケット不可の制約下でも送信 HTTP を実現でき、JWKS 取得や外部連携が可能になる。
- API 型をサーバと共有でき、`servant-client` 流の型安全なクライアントが得られる。
- TLS をランタイムに委譲でき、依存とバンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）を抑えられる。

### 悪い結果・トレードオフ (Negative)

- `http-client` 固有の機能（コネクションプール、低レベルタイムアウト制御等）は使えず、`fetch` の
  できる範囲に縛られる。
- `RunClient` バックエンドの実装・互換テスト工数。

### 中立・フォローアップ (Neutral / Follow-up)

- `fetch` のオプション（`cf` プロパティ、キャッシュ制御、リトライ）をクライアント抽象にどう露出するか設計する。
- Service Bindings RPC とプレーン `fetch` を同一抽象で扱う際の差異を吸収する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `servant-client-core` 再利用 + `fetch` バックエンド（自前）

- 利点: ソケット不要・型共有・TLS 委譲・依存最小。方針と整合。
- 欠点: `http-client` の低レベル機能は不可、実装工数。

### `servant-client` + `http-client`

- 利点: 既存実装をそのまま使える。
- 欠点: `network` 依存で **ビルド不能**。ソケットも `ENOSYS`。採用不可。

### 都度 `fetch` 直書き

- 利点: 前準備が最小。
- 欠点: 型安全性が低く重複が多い。サーバとの型共有が得られない。

## 遵守事項 (Compliance)

- [ ] 送信は `fetch`（JSFFI）を用い、`http-client`/`network`/ソケットへ依存しない。
- [ ] クライアントは `servant-client-core` を入力に取り、API 型をサーバと共有する。
- [ ] TLS スタックを Haskell 側に持ち込まない。
- [ ] 送信にはタイムアウト（AbortSignal）を付与し、リトライは冪等メソッドに限定する。

## 参考資料 (References)

- Haskell Discourse — Blog system on Cloudflare Workers（`servant-client-fetch` が Fetch を backend に）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- @cloudflare/workers-wasi（ソケット syscall は ENOSYS）: https://www.npmjs.com/package/@cloudflare/workers-wasi
- GHC User's Guide — WebAssembly backend（async JSFFI / Promise）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html

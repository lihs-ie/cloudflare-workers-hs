# 調査メモ: Haskell Servant を Cloudflare Workers で実運用する技術的可能性

- 作成日: 2026-06-20
- 目的: `cloudflare-workers-hs` が「Servant を Cloudflare Workers 上で不自由なく使う」ために
  必要となるライブラリ機能を洗い出し、各 ADR の根拠とする。
- 手法: 多角的な Web 調査 → 一次情報の取得 → 主張の敵対的検証 (adversarial verification)。
  本書は検証済みの主張と一次ソースを統合した要約である。

> 補足: 自動合成ステップは調査基盤側の一時的なレート制限で複数回失敗したため、検証済みの
> 主張群を人手で統合した。技術的な調査自体（5 観点の探索・15 ソースの取得・13 主張の 3 票
> 敵対的検証）は完了している。

---

## 1. エグゼクティブサマリ

- **最新の Haskell→WASM 経路は GHC ネイティブ WebAssembly バックエンド (`wasm32-wasi`) であり、
  Asterius は 2022-11-24 にアーカイブされ非推奨**である。本ライブラリのツールチェーンは GHC
  ネイティブバックエンド一択。
- **`servant-server` をそのまま Workers 上で使うことはできない。** 推移的に `network` パッケージへ
  依存し、これが `wasm32-wasi` でビルドできないためである。
- **先行実装が既に存在する。** konn 氏が `servant-server` をフォークした
  `servant-cloudflare-workers` と、ビルド基盤・Cloudflare バインディング群を含む
  `ghc-wasm-earthly` を公開し、本番ブログ (gohan.konn-san.com / `konn/humblr`) を Workers 上で
  GHC WASM バックエンド + Servant で稼働させている。**本ライブラリはこの先行事例を一次の
  設計参照とする。**
- **WAI を介さず Cloudflare の `Request`/`Response` を直接扱う**のが実運用上の妥当解である。
  理由は (a) CPU 予算が短い（無料枠で 1 リクエストあたり概ね 10ms 級）こと、(b) Workers は本文を
  `ReadableStream` で扱うため WAI へ変換するとコストとレイテンシが増えること、(c) そもそも
  `network` 依存で WAI/Warp が動かないこと。
- **暗号は `crypton`/`cryptonite` がビルド不能**なため、JWT/認証は Cloudflare の標準
  `SubtleCrypto` API を JSFFI 経由で用いる方針へ転換する必要がある。

---

## 2. 機能別の実現可否マトリクス

| 機能 / 要素 | 判定 | 実現手段・根拠 |
| --- | --- | --- |
| Haskell→WASM コンパイル | ✅ 可能 | GHC ネイティブ `wasm32-wasi` バックエンド（要カスタム GHC ビルド） |
| JSFFI（JS 双方向呼び出し） | ✅ 可能 | `foreign import/export javascript`、async は Promise + `await` |
| Template Haskell / ghci | ✅ 可能 (GHC 9.12+) | 外部インタプリタ（Node.js）で splice を評価 |
| Servant 型レベル API DSL | ⚠️ 要改変 | `servant` コア DSL を再利用し `HasServer` 相当を自前実装（フォーク/`Steward` 依存はしない）— 確定: [ADR-0006](../adr/0006-servant-execution-engine.md) |
| `servant-server`（WAI 版） | ❌ 不可 | 推移的 `network` 依存が `wasm32-wasi` で未ビルド |
| WAI / Warp ソケットサーバ | ❌ 不可 | WASI のソケット syscall (`sock_*`, `poll_oneoff`) が `ENOSYS` |
| fetch ハンドラ | ✅ 可能 | reactor モジュール + `foreign export javascript` |
| JSON / コンテンツネゴシエーション | ✅ 可能 | `aeson` 等は純 Haskell でビルド可 |
| レスポンス/リクエストのストリーミング | ✅ 可能（直接） | Cloudflare `Request`/`Response` を直接扱い `ReadableStream` を素通し |
| KV / R2 / D1 / Service Bindings | ✅ 可能 | 自前 JSFFI バインディングで実装（`ghc-wasm-earthly` は設計参照・実績のみ、依存しない） |
| Durable Objects / Queues / Cache | ⚠️ 要バインディング | JSFFI で追加実装が必要 |
| 認証 (JWT) / `crypton` | ❌→⚠️ 要転換 | **第一級: Cloudflare Access JWT を `SubtleCrypto` で検証**。副系: 独自 JWT（`crypton` 不可）— 確定: [ADR-0009](../adr/0009-auth-zero-trust-subtlecrypto.md) |
| WebSocket | ⚠️ 要 Durable Objects | `Upgrade` を Worker が受け、Durable Object が接続を保持 |
| 送信 HTTP (`servant-client`) | ⚠️ 要 fetch backend | `servant-client-core` を再利用し fetch backend を自前実装（`servant-client-fetch` は設計参照）。ソケット不可 |
| WAI ミドルウェア | ❌ 不可 | WAI 非採用 → Servant/JSFFI レベルの代替手段で提供 |
| 可観測性（ログ/トレース） | ✅ 可能 | `console.*` を JSFFI 経由、tail workers |
| 並行性 | ⚠️ 制約あり | 単一スレッド RTS（`-threaded` 不可）、async JSFFI で軽量並行 |

---

## 3. 検証済みの主要主張（3 票敵対的検証で確認）

1. GHC wasm バックエンドはネイティブクロスコンパイラで、ターゲットは `wasm32-wasi`。
   Asterius/GHCJS とは別物で、専用の GHC ビルドが必要（stock GHCup ではない）。
2. JSFFI: `unsafe` import は同期、`safe`/`interruptible`/無注釈 import は非同期で Promise を返し
   `await` 可能。export は既定で非同期 (Promise を返す)。
3. post-linker (`post-link.mjs`、GHC libdir に同梱) が `.wasm` を解析し、`ghc_wasm_jsffi` の
   import を生成する JS モジュールを出力する。生成 JS はホスト非依存（ブラウザでも動く）。
4. JSFFI 利用時は `wasm32-wasi` の **reactor** モジュールとしてビルドする
   (`-no-hs-main -optl-mexec-model=reactor` + `--export`)。`_initialize` を他の export 呼び出し前に
   **一度だけ**呼ぶ。読み込みは `WebAssembly.instantiate` に `ghc_wasm_jsffi` と
   `wasi_snapshot_preview1` の import を渡す。
5. 現状 RTS は単一スレッド（`-threaded` なし）。async JSFFI が Promise を包む thunk で安価な並行性を
   提供するが、C-FFI で export した Haskell 関数から async JSFFI thunk を force すると
   `WouldBlockException` が送出される。
6. TH/ghci は GHC 9.12 から対応。
7. Asterius は GHC wasm バックエンドに置き換えられ非推奨、リポジトリは 2022-11-24 にアーカイブ。
8. `servant-server` は推移的に `network` に依存し WASM バックエンドでビルドできない。konn 氏は
   WASM で動く Servant 風の型駆動ルータを自作した。
9. Haskell WASM モジュールは `@cloudflare/workers-wasi` を使って reactor として workerd に読み込む。
   同ライブラリには `wasi.initialize()` が無いため、ダミーの `_start()` を与えて `wasi.start()` を
   呼ぶ。Worker は既定 export として `fetch` ハンドラを公開する。
10. 本番ブログ (gohan.konn-san.com, `github.com/konn/humblr`) が GHC WASM + Servant で稼働。

## 4. 一次ソースから補強した設計事実（konn エコシステム）

- konn 氏は `servant-server` を **`servant-cloudflare-workers`** にフォークし、WAI を介さず
  Cloudflare の `Request`/`Response` を直接扱う。理由は「10ms 級の予算内に完了させる必要があり、
  Workers は内容を `ReadableStream` で返すため、WAI への変換が実行時間を浪費する」。
- `servant-cloudflare-workers` は **Hackage 未公開**（Hackage では 404）。採用するなら git 依存か
  ベンダリングになる。
- konn 氏は後継として **`Steward`**（Servant `Generic` インターフェースのサブセット、Workers と
  client の両方で動作）を開発。`ghc-wasm-earthly` 内の servant-workers ブリッジは
  「使用を推奨しない」と明記。
- 送信は **`servant-client-fetch`**（Fetch API を JSFFI 経由で backend に使用）。
- 認証は **Cloudflare Zero Trust (Access) を第一級**とし、Access JWT を **`SubtleCrypto`** で検証する
  （`crypton`/`cryptonite` はビルド不能）。独自 JWT は副系として `SubtleCrypto` で扱う。
- Cloudflare バインディングは `ghc-wasm-earthly` が **D1 / R2 / KV / Service Bindings** を提供。
  Service Bindings は JS の RPC 機構を利用。
- バンドルサイズ（現行・2026-06 時点）: **無料枠 3 MiB / 有料 10 MiB（gzip 後）、圧縮前 64 MB**（両プラン共通）。
  先行事例（当時の 1 MiB 制限下）は機能を 5 つの Worker に分割していた（Router ~995 / Database ~758 /
  Storage ~722 / Images ~664 / SSR ~977 KiB、圧縮後）が、これらは現行 3 MiB に収まるため**分割は当時の
  名残であり現在は必須でない**（[ADR-0014](../adr/0014-bundle-size-limits-performance.md)）。
- ビルド基盤は **Earthly** ＋ GHC 9.10 wasm（ghcup インストールスクリプト経路、Nix flake も提供）。
  コンテナ `ghcr.io/konn/ghc-wasm-earthly` あり。`ghc-wasm-compat` で vanilla GHC でも型検査可能。
- Workers 側の制約: ソケット系 WASI syscall は `ENOSYS`。`@cloudflare/workers-wasi` は実験的で
  最終リリース v0.0.5 (2022-02-07)、事実上メンテされておらず本番依存には注意。

## 5. 未解決・要追加検証の論点

- workerd への reactor モジュール組み込みの「正典」手順（`@cloudflare/workers-wasi` の実験的・
  非保守状態を踏まえ、最小自前 WASI shim を用意すべきか）。
- 長命 isolate における線形メモリの単調増加と GC 挙動の実測。
- D1/Durable Objects/Queues の各バインディングの API 形状（一次コードの精読が必要）。
- ~~`servant-cloudflare-workers` を採用 vs `Steward` を採用 vs 独自実装の最終判断~~
  → **プロジェクト方針により「フォークせず全て自前実装」で確定**（[ADR-0006](../adr/0006-servant-execution-engine.md)）。
  konn 各ライブラリは依存に含めず、設計参照のみとする。
- 認証は **Cloudflare Zero Trust (Access) を一級に活用**する方針で確定（[ADR-0009](../adr/0009-auth-zero-trust-subtlecrypto.md)）。

## 6. 参考資料（一次ソース）

- GHC User's Guide — WebAssembly backend: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Tweag — Template Haskell and GHCi for Wasm: https://www.tweag.io/blog/2024-11-21-ghc-wasm-th-ghci/
- Tweag — The Wasm backend is merged into GHC: https://www.tweag.io/blog/2022-11-22-wasm-backend-merged-in-ghc
- Tweag — Asterius on Cloudflare Workers (2020): https://www.tweag.io/blog/2020-10-09-asterius-cloudflare-worker/
- Asterius（アーカイブ済み）: https://github.com/tweag/asterius
- Haskell Discourse — Serverless Haskell with GHC WASM + JSFFI on Cloudflare Workers: https://discourse.haskell.org/t/serverless-haskell-with-ghc-wasm-jsffi-cloudflare-workers/9784
- Haskell Discourse — Blog system on Cloudflare Workers (Servant + Miso): https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- konn/ghc-wasm-earthly: https://github.com/konn/ghc-wasm-earthly
- Cloudflare — Announcing WASI on Workers: https://blog.cloudflare.com/announcing-wasi-on-workers/
- @cloudflare/workers-wasi (npm): https://www.npmjs.com/package/@cloudflare/workers-wasi
- Cloudflare Durable Objects — WebSocket server: https://developers.cloudflare.com/durable-objects/examples/websocket-server/
- Cloudflare Workers — Streams: https://developers.cloudflare.com/workers/runtime-apis/streams/
- Cloudflare Workers — Limits: https://developers.cloudflare.com/workers/platform/limits/
- finley.dev — Compiling Haskell to WASM: https://finley.dev/blog/2024-08-24-ghc-wasm.html

# ADR-0007: リクエスト/レスポンス本文は ReadableStream を素通しでストリーミングする

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0005](./0005-http-layer-no-wai.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0014](./0014-bundle-size-limits-performance.md)

## 背景と課題 (Context)

Cloudflare Workers は本文を `ReadableStream` として授受し、`Response` も `ReadableStream` を本文に取れる。
本ライブラリは WAI を介さず直接 `Request`/`Response` を扱う（[ADR-0005](./0005-http-layer-no-wai.md)）ため、
本文の表現とストリーミング方針を定める必要がある。Servant には `StreamGet`/`StreamBody` 等の
ストリーミング組み合わせ子があり、これらを Workers のストリームへどう写すかも論点となる。

短い CPU 予算・限られたメモリ（[ADR-0014](./0014-bundle-size-limits-performance.md)）下では、
大きな本文を Haskell ヒープへ全量バッファリングするのは不利であり、可能な限りストリームのまま
流すことが望ましい。

## 決定要因 (Decision Drivers)

- 大きな本文を全量バッファせずに扱えること（メモリ・CPU 予算）
- 変換コストを最小化し `ReadableStream` を素通しできること
- Servant のストリーミング組み合わせ子と整合する API を提供できること
- async JSFFI（Promise/`await`）でのチャンク読み出しに対応できること

## 検討した選択肢 (Considered Options)

1. **本文を `ReadableStream` のまま保持し、素通し優先・必要時のみ取り込む遅延表現にする**
2. 受信時に本文を全量バイト列へ取り込み、送信時も全量から `Response` を作る
3. 本文を独自のチャンク列（pull 型イテレータ）へ常時変換して扱う

## 決定 (Decision)

採用する選択肢: **選択肢 1（`ReadableStream` 素通しを既定、明示時のみ取り込み）**

- 受信本文は既定で `ReadableStream` ハンドル（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) のバインディング型）として保持し、
  ハンドラが JSON/テキスト/バイト列として**明示的に要求したときだけ** `await` で取り込む。
- 応答本文は、(a) 小さい確定値はバイト列、(b) 大きい/ストリーミングは `ReadableStream` を**そのまま** `Response` に渡す、
  の 2 経路を用意する。プロキシ的にアップストリームの `ReadableStream` を下流へ素通しできるようにする。
- Servant の `StreamBody`/`StreamGet` 等は、この `ReadableStream` 素通し経路へ写像する解釈を
  サーバ解釈系（[ADR-0006](./0006-servant-execution-engine.md)）に実装する。チャンク読み出しは
  async JSFFI（Promise/`await`）で表現する。
- **本文サイズ上限**: 明示取り込み（`await` で JSON/バイト列化）には既定の最大バッファサイズを設け、超過時は
  **413 (Payload Too Large)** を返す。128 MB メモリ・短い CPU 予算（[ADR-0014](./0014-bundle-size-limits-performance.md)）下での
  無制限取り込みによるメモリ/CPU 枯渇を防ぐ。入力検証はデコード段の前後に配置する。

## 結果 (Consequences)

### 良い結果 (Positive)

- 大きな本文でもメモリを節約でき、変換コストを避けて CPU 予算を守れる。
- アップストリーム（R2/オリジン/Service Binding）からのストリームをプロキシ的に下流へ流せる。

### 悪い結果・トレードオフ (Negative)

- ストリームは基本「一度しか読めない」ため、本文を複数回参照する処理（再試行・署名検証など）は
  明示的な取り込み（バッファ）を要し、設計上の注意が必要。
- async（Promise）境界がハンドラ内に増え、単一スレッド RTS・`WouldBlockException`（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）の制約と整合させる必要がある。

### 中立・フォローアップ (Neutral / Follow-up)

- 「取り込み済みバイト列」と「未読ストリーム」を型で区別し、二重読みを型レベルで防ぐ設計を検討する。
- バックプレッシャ/チャンクサイズの既定値は実測（[ADR-0014](./0014-bundle-size-limits-performance.md)）で調整する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### `ReadableStream` 素通し（既定）+ 明示取り込み

- 利点: 省メモリ・低変換コスト・プロキシ素通し。Workers の実態に最適。
- 欠点: 一度しか読めない制約への配慮が必要。

### 常時全量バッファ

- 利点: 実装が単純で本文を何度でも読める。
- 欠点: 大きな本文でメモリ・CPU を浪費。Workers 制約に反する。

### 常時チャンク列へ変換

- 利点: 抽象が一貫。
- 欠点: 素通しできず変換コストが常に乗る。`ReadableStream` を直接渡せる利点を捨てる。

## 遵守事項 (Compliance)

- [ ] 受信本文は既定でストリームとして保持し、要求時のみ取り込む。
- [ ] 応答本文に `ReadableStream` をそのまま渡せる経路を提供する（全量バッファを強制しない）。
- [ ] ストリームの二重読みを行わない（必要時は明示取り込み結果を再利用する）。
- [ ] 明示取り込みには最大バッファサイズの上限を設け、超過時は 413 を返す。

## 参考資料 (References)

- Cloudflare Workers — Streams API: https://developers.cloudflare.com/workers/runtime-apis/streams/
- Haskell Discourse — Blog system on Cloudflare Workers（ReadableStream 素通しの動機）: https://discourse.haskell.org/t/blog-system-on-cloudflare-workers-powered-by-servant-and-miso-using-ghc-wasm-backend/10666
- GHC User's Guide — WebAssembly backend（async JSFFI）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html

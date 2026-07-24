# ADR-0010: WebSocket は Durable Objects を介して実現する

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0008](./0008-cloudflare-platform-bindings.md)

## 背景と課題 (Context)

Servant には `servant-websockets` があり、WAI/Warp 上で WebSocket を扱う。しかし本ライブラリは
WAI を介さず（[ADR-0005](./0005-http-layer-no-wai.md)）、ソケットも使えない（WASI `sock_*` は `ENOSYS`）。
Cloudflare Workers の WebSocket は、(1) Worker が `Upgrade: websocket` を受けて `WebSocketPair` で
101 応答を返し、(2) 接続の保持・状態管理は **Durable Object (DO)** が担う、というモデルである。
DO は接続をハイバネーション込みで保持できる。したがって `servant-websockets` を素の Worker ハンドラへ
そのまま写すことはできず、DO を背後に置く必要がある。

## 決定要因 (Decision Drivers)

- Workers の WebSocket モデル（Upgrade → DO 保持）に正しく対応すること
- Servant の宣言的記述から WebSocket エンドポイントを表現できること
- 接続保持・複数接続・ハイバネーションを扱えること
- 段階的導入（まず最小の双方向通信）が可能なこと

## 検討した選択肢 (Considered Options)

1. **WebSocket 用組み合わせ子を提供し、Worker でのアップグレードと Durable Object による接続保持を自前バインディングで実現する**
2. `servant-websockets` をそのまま使う
3. WebSocket を当面サポート外とし、HTTP/SSE 等で代替する

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- 本ライブラリ独自の WebSocket 組み合わせ子（例: `WebSocketCloudflare`）を用意し、サーバ解釈系
  （[ADR-0006](./0006-servant-execution-engine.md)）が `Upgrade: websocket` リクエストに対して
  `WebSocketPair` を生成し 101 応答を返す処理を実装する。
- 接続の保持・メッセージ送受信・複数クライアント管理は **Durable Object** に委譲する。DO クラスは
  JS 側に export しつつ、その振る舞い（`fetch`/`webSocketMessage`/`webSocketClose` 等のハンドラ）を
  Haskell 側で実装し、JSFFI バインディング（[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md),
  [ADR-0008](./0008-cloudflare-platform-bindings.md)）で `WebSocketPair`・`state.acceptWebSocket`・
  ハイバネーション API を扱う。
- 実装は段階的とし、**MVP は単一 DO による双方向エコー/ブロードキャスト**程度から始め、ハイバネーション
  最適化は後続で対応する。

## 結果 (Consequences)

### 良い結果 (Positive)

- Workers のモデルに沿った正しい WebSocket 実装になり、接続保持・状態管理を DO に任せられる。
- Servant の API 記述に WebSocket エンドポイントを組み込める。

### 悪い結果・トレードオフ (Negative)

- **Durable Objects が前提**となり、DO のクラス定義（JS export）・課金/設定（`wrangler`: [ADR-0015](./0015-build-deploy-ci-pipeline.md)）が必要。
  素の Worker だけで完結しない。
- DO の `fetch`/WebSocket ハンドラを Haskell から扱うバインディングの実装コストが高い。
- `servant-websockets` とは API が異なるため互換ではない。

### 中立・フォローアップ (Neutral / Follow-up)

- ハイバネーション API（`acceptWebSocket` + イベントハンドラ）対応の優先度を決める。
- DO の ID 割り当て（接続のルーム/グルーピング）方針を設計する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 独自組み合わせ子 + Durable Object 保持

- 利点: Workers モデルに忠実、状態管理を DO に委譲、Servant 記述に統合。
- 欠点: DO 必須、バインディング実装コスト。

### `servant-websockets` をそのまま

- 利点: 既存の Servant WebSocket 記法。
- 欠点: WAI/ソケット前提で **Workers では動作しない**。採用不可。

### 当面サポート外（HTTP/SSE 代替）

- 利点: 初期実装を軽くできる。
- 欠点: 双方向リアルタイム要件を満たせず、「不自由なく」に反する。

## 遵守事項 (Compliance)

- [ ] WebSocket は `Upgrade` 受理 → `WebSocketPair` → Durable Object 保持の経路で実装する。
- [ ] ソケット/`servant-websockets` に依存しない。
- [ ] DO クラスは JS export しつつ振る舞いを Haskell 側で実装する。

## 参考資料 (References)

- Cloudflare Durable Objects — WebSocket server: https://developers.cloudflare.com/durable-objects/examples/websocket-server/
- @cloudflare/workers-wasi（ソケット syscall は ENOSYS）: https://www.npmjs.com/package/@cloudflare/workers-wasi
- Cloudflare Workers — Streams: https://developers.cloudflare.com/workers/runtime-apis/streams/

## 追補 (2026-07-23): Phase A theme A4 で確定した DO WebSocket hibernation 実装

- ステータス: 承認（追補）
- 日付: 2026-07-23
- 決定者: lihs

Phase A theme A4（Queue/DO/WebSocket/非 fetch エントリポイント、実機検証済み）で確定した設計を記録する。
本文「結果 (Consequences)」節の「中立・フォローアップ」が「ハイバネーション API 対応の優先度を決める」と
していた論点に対する実装レベルの確定を含む。本文自体は書き換えない。

### 決定 1: hibernation API を主実装とし、standard accept() は不実装とする（転換、lihs 承認 2026-07-23）

本文は当初、MVP を「単一 DO による双方向エコー/ブロードキャスト程度」から始め「ハイバネーション最適化は
後続で対応する」という順序を想定していた。実装では、この順序を覆し、**ハイバネーション API
（`ctx.acceptWebSocket` + `webSocketMessage`/`webSocketClose` という DO クラスの static メソッドへ
Haskell foreign export を委譲する形）を最初から主実装とし、standard accept（`server.accept()` +
プレーンなイベントリスナー方式、DO クラスメソッドを介さない形）は実装しない**方針へ確定した
（A4 plan 裁定 1、★2 改訂。lihs 承認 2026-07-23）。

根拠:

- **課金**: standard accept は接続の保持時間そのものに対して課金される（duration billing）のに対し、
  hibernation はメッセージ処理時間のみに課金され、アイドル接続のコストを回避できる。
- Cloudflare 自身がハイバネーション API を推奨している。
- ハイバネーションの `webSocketMessage`/`webSocketClose` という「JS 側 class メソッドが駆動する」モデルは、
  Haskell `foreign export javascript`（「JS から呼ばれる」形）と自然に整合する。DO クラスの `fetch`
  メソッドと `webSocketMessage`/`webSocketClose` メソッドはいずれも**同一 `wasmExports` インスタンス
  （同一 isolate・同一 wasm module instance）を共有する**ことを実機で実証済み（A4 batch 1、
  「世界初チェックポイント」— DO クラスメソッドから Haskell-wasm reactor の export を呼べるかという
  A4 全体の前提条件、一発 GREEN で設計 pivot 不要だった）。

### 決定 2: WebSocketMessagePayload 型 + bytes 送受信

```haskell
data WebSocketMessagePayload = WebSocketTextMessage Text | WebSocketBinaryMessage ByteString
  deriving stock (Show, Eq)

webSocketSend :: WebSocketConnection -> WebSocketMessagePayload -> IO ()
```

`webSocketSend` は実 `WebSocket#send(message)` に対応する（real-API ドキュメント上は同期・`Promise` を
返さないが、ソケットが `OPEN` 状態でない場合に throw するため、`WebSocketSendFailed` として分類し
JS 側 `try`/`catch` で封筒化する）。当初この型は `WebSocketIncomingMessage` という名だったが、
`webSocketSend` が同じ型を送信（OUT 方向）にも使うため「incoming」は方向性として誤解を招くとして
`WebSocketMessagePayload` へ改名した（構築子・フィールドの変更は無い、単純な rename。A4 close
reviewer fix #5）。

**実測 footgun**: ローカル test harness（`@cloudflare/vitest-pool-workers`）が生成する `WebSocket`
client は `binaryType` のデフォルトが `"blob"`（Fetch 標準自体のデフォルト）であるため、未設定のまま
バイナリフレームを受信すると `event.data` は `ArrayBuffer` ではなく `Blob` として届く。`client.binaryType
= "arraybuffer"` をメッセージ到達前に明示設定することで、通常のブラウザ/workerd の WebSocket client と
同じ `ArrayBuffer` 形状を直接取得できる（harness 固有の制限ではなく、素の WebSocket API の挙動）。

### 決定 3: servant WebSocket combinator は未実装（Remaining scope として明記）

本 ADR 本文の中核である「本ライブラリ独自の WebSocket 組み合わせ子（例: `WebSocketCloudflare`）を
Servant の宣言的記述へ組み込む」という決定は、**A4 のスコープでは実装していない**。A4 が実装したのは
DO クラスメソッドへの JS glue 委譲によるハイバネーション基盤のみであり、`HasWorkerServer`/`Server api
env`（[ADR-0006](./0006-servant-execution-engine.md)）の外側で完結する。実 Upgrade リクエストの
`new WebSocketPair()`/`this.ctx.acceptWebSocket(server)`/`new Response(null, { status: 101, webSocket:
client })` という一連の流れも、entirely JS 側（DO クラスの `fetch` メソッド）の責務のままであり、
Haskell 側に対応するエントリポイントは無い（`101` 応答の `webSocket` プロパティは workerd 固有の
非シリアライズ可能な client-socket 参照であり、通常の Fetch 標準の `Response` コンストラクタでは
構築しえないため）。`servant-cloudflare-workers` には `:> WebSocket`（またはそれに類する）combinator は
現状存在せず、これを使いたいチャプターがあっても現時点では手を伸ばす先が無い。

### 実測で確定した挙動（記録）

- ローカル harness（`@cloudflare/vitest-pool-workers`）では client 側の close event が発火しない —
  `client.close(code, reason)` の呼び出しはクローズフレームの送信のみを行い、実際のクローズ
  ハンドシェイク完了（server 側で `webSocketClose` が実行され副作用が書き込まれる）はその呼び出しの
  return までに完了せず、1 マクロタスクぶんの yield を挟んでも確実には完了しない。2 つの同期戦略を
  試行した: (1) client 自身の `"close"` イベントを await する — 5 秒のタイムアウトを設けても一度も
  発火が観測されなかった（`DurableObjectStub#fetch(...)` 経由で取得した `WebSocket` に対して、実
  トップレベル `SELF.fetch` を経由しない場合）。(2) `URL_SHORTENER_KV` への痕跡書き込みを bounded
  poll する（`Cloudflare.Workers.Entrypoint.Queue` の producer→consumer 実配信検証で確立した
  bounded-poll の precedent と同じ形）— こちらは 3 回連続のフルスイート実行で flake 無く安定して
  観測できた。根本原因は追跡していないが、「workerd は本サンドボックス内で実 I/O が無い限り実時間を
  凍結する」という既知の artifact クラス（`wait-until.spec.ts` のヘッダコメントが既に文書化）の
  3 例目（background timer・Queue 自動配信に続く、WebSocket クローズハンドシェイクの確認応答）と
  推測される。
- DO クラスの `fetch` メソッドは worker が通常の `fetch` リクエストで既に使っている同一 module
  instance（`wasmExports` 閉包）を WebSocket コールバック（`webSocketMessage`/`webSocketClose`）に
  対しても共有する。

### 遵守事項への影響（本文 override）

- 「本ライブラリ独自の WebSocket 組み合わせ子（例: `WebSocketCloudflare`）を用意し … `Upgrade: websocket`
  リクエストに対して `WebSocketPair` を生成し 101 応答を返す処理を実装する」→ 追補により、この
  combinator 自体は A4 の時点で未実装（決定 3）。実装済みなのは DO クラスメソッド
  （`webSocketMessage`/`webSocketClose`）への委譲基盤のみ。「Servant の API 記述に WebSocket
  エンドポイントを組み込める」という「結果 (Consequences)」節の Positive な主張は、servant combinator
  実装まで持ち越しとなる。
- 「実装は段階的とし、MVP は単一 DO による双方向エコー/ブロードキャスト程度から始め、ハイバネーション
  最適化は後続で対応する」→ 追補により順序が逆転。ハイバネーションを最初から主実装として採用し、
  standard accept は実装しない方針へ確定した（決定 1）。

### 参考資料（追補分）

- Cloudflare Durable Objects — WebSocket Hibernation API: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- [ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md) 追補（JSFFI 境界の実装規約 — safe/unsafe 割当・
  JS 側 try/catch 封筒）
- [ADR-0008](./0008-cloudflare-platform-bindings.md) 追補（A4 分。`dos` slot 実体化・DO storage・
  `doFetch`/`serviceFetch` の URL 再構成）
- 実装詳細・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a4-plan.md`、
  `_phase_b/divergence-notes.md`「A4 batch 5」節、`API-LEDGER.md` 該当節

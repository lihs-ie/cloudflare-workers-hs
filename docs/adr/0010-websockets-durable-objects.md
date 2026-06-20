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

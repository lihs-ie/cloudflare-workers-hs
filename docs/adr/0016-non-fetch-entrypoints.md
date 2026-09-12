# ADR-0016: Worker の非 fetch エントリポイント（scheduled / queue / tail）を扱う

- ステータス: 承認
- 日付: 2026-06-20
- 決定者: lihs
- 関連: [ADR-0002](./0002-wasi-reactor-workerd-integration.md), [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md), [ADR-0006](./0006-servant-execution-engine.md), [ADR-0008](./0008-cloudflare-platform-bindings.md), [ADR-0013](./0013-observability.md), [ADR-0015](./0015-build-deploy-ci-pipeline.md)

## 背景と課題 (Context)

これまで本ライブラリが入口として定義したのは `fetch` ハンドラのみである
（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）。しかし module 形式の Cloudflare Worker は
`export default { ... }` の中で `fetch` 以外にも複数のエントリポイントを公開でき、実運用ではこれらが必要になる。

- **`scheduled(controller, env, ctx)`**: Cron Triggers から定期実行される。`controller` は
  `cron`（発火した Cron 式）・`scheduledTime`（予定時刻）・`type`（常に `"scheduled"`）を持ち、
  `controller.noRetry()` で再試行を抑止できる。HTTP リクエストは伴わない。
- **`queue(batch, env, ctx)`**: Cloudflare Queues のコンシューマ（消費側）として、メッセージの
  バッチ（`MessageBatch`）を受け取る。各メッセージは `ack()` / `retry()` でき、バッチ全体にも
  `ackAll()` / `retryAll()` がある。**[ADR-0008](./0008-cloudflare-platform-bindings.md) は Queues の
  プロデューサ（送信側）バインディング（`send`/`sendBatch`）のみを定義しており、消費側の入口は
  未定義のままになっている。本 ADR がこの欠落を埋める。**
- **`tail(events, env, ctx)`**: Tail Worker として、他の Worker の実行イベント（ログ・例外・サブリクエスト
  情報）のバッチを受け取る。可観測性の収集経路（[ADR-0013](./0013-observability.md)）に直結する。
- **`email(message, env, ctx)`**: Email Routing のハンドラ。受信メールを処理する。実運用上の優先度は
  低いが、入口の追加方式は他と同型である。

これらはいずれも JS 側で `export default { fetch, scheduled, queue, tail }` のように並べて公開される。
本ライブラリはこれらの入口を Haskell（WASM, reactor モジュール: [ADR-0002](./0002-wasi-reactor-workerd-integration.md)）側で
扱えるようにし、`fetch` 専用に閉じている現状を超えて実運用の Worker パターンを網羅する必要がある。

ここで論点が 2 つある。第一に、reactor の初期化（`_initialize` / RTS 初期化）は
[ADR-0002](./0002-wasi-reactor-workerd-integration.md) / [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)
で「isolate 起動時に一度だけ」と定めたが、これがどの入口から発火しても成り立つ必要がある。第二に、
`scheduled` / `queue` は HTTP 形ではない（URL・メソッド・ヘッダ・ステータスコードを持たない）ため、
Servant の実行エンジン（[ADR-0006](./0006-servant-execution-engine.md)）をそのまま流用するのが妥当かを判断する必要がある。

## 決定要因 (Decision Drivers)

- module 形式 Worker の `scheduled` / `queue` / `tail`（必要なら `email`）の各形状に素直に対応すること
- 初期化（`_initialize` / RTS）を isolate あたり一度に保ち、どの入口が最初に発火しても整合すること
  （[ADR-0002](./0002-wasi-reactor-workerd-integration.md) / [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）
- `env` バインディング（[ADR-0008](./0008-cloudflare-platform-bindings.md)）と可観測性
  （[ADR-0013](./0013-observability.md)）を全入口で共有・再利用できること
- HTTP 形でない処理に HTTP 形の解釈系を強いないこと（型の素直さ・無駄なオーバーヘッド回避）
- Queues の消費側という現状の欠落（[ADR-0008](./0008-cloudflare-platform-bindings.md)）を埋めること
- 単一スレッド RTS と async JSFFI の制約下で正しく動くこと

## 検討した選択肢 (Considered Options)

1. **`scheduled` / `queue`（および `tail` / `email`）を型付きの第一級ハンドラとして実装し、`fetch` と並べて `foreign export javascript` で公開する**
2. `fetch` のみを公開し、背景処理は別の JS Worker（または別言語の Worker）に逃がす
3. Cron を外部トリガ（外部スケジューラからの HTTP 呼び出し）で疑似し、すべてを `fetch` 内に集約する

## 決定 (Decision)

採用する選択肢: **選択肢 1**

- **型付きハンドラ署名**: 各入口に対応する Haskell ハンドラを定義し、`foreign export javascript` で
  `fetch`（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）と並べて公開する。JS の薄いエントリ
  （`export default { fetch, scheduled, queue, tail }`、[ADR-0015](./0015-build-deploy-ci-pipeline.md) の
  バンドル）は各 export を呼ぶだけにする。各引数はバインディング層
  （[ADR-0003](./0003-jsffi-cloudflare-bindings-layer.md)）の型でラップして渡す。署名は概念的に次の通り。

  - `scheduled :: ScheduledController -> Env -> Context -> IO ()`
    （`ScheduledController` は `cron` / `scheduledTime` / `noRetry` を持つ）
  - `queue :: MessageBatch a -> Env -> Context -> IO ()`
    （各 `Message a` は本文・メタデータと `ack` / `retry`、バッチに `ackAll` / `retryAll`）
  - `tail :: TailEventBatch -> Env -> Context -> IO ()`
  - `email :: EmailMessage -> Env -> Context -> IO ()`（後続で拡充）

- **初期化の共有**: `_initialize` / RTS 初期化は **どの入口が最初に発火するかに関わらず、isolate あたり
  一度だけ**行う（[ADR-0002](./0002-wasi-reactor-workerd-integration.md) /
  [ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）。初期化は特定の入口（`fetch`）に紐付けず、
  reactor の `_initialize` として全 export 呼び出しの前に一度だけ走らせる。`main` は引き続き no-op とする。

- **解釈系の使い分け**: `scheduled` / `queue` / `tail` は HTTP 形ではないため、Servant の実行エンジン
  （[ADR-0006](./0006-servant-execution-engine.md)）を**流用しない**。代わりに、入口ごとの軽量な型付き
  ディスパッチを設ける。`queue` はメッセージ本文の型（例: JSON ペイロード）でハンドラを分岐させ、
  `scheduled` は `controller.cron` の値でジョブを分岐させる（複数の Cron 式を 1 つの Worker に同居させる
  ため）。`fetch` 経路だけが従来どおり Servant の型レベル API を通る。

- **共有資源の再利用**: 入口が違っても、**`env` バインディング**（KV/R2/D1/Durable Objects/Queues 送信/
  Service Bindings、[ADR-0008](./0008-cloudflare-platform-bindings.md)）と**可観測性**
  （構造化ログ・例外捕捉、[ADR-0013](./0013-observability.md)）は共通の層を再利用する。`ctx.waitUntil` /
  `ctx.passThroughOnException` の契約（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）も
  `scheduled` / `queue` で同様に提供する。

- **Queues 消費側の確定**: 本 ADR をもって、Queues は**送信側（プロデューサ、
  [ADR-0008](./0008-cloudflare-platform-bindings.md)）と消費側（コンシューマ、本 ADR の `queue`
  ハンドラ）の両方**を扱えることを確定する。コンシューマの登録は `wrangler.toml` の Queues consumer 宣言
  （[ADR-0015](./0015-build-deploy-ci-pipeline.md)）と Haskell 側 `queue` export を対応させる。

- **段階的対応**: MVP は **`scheduled` と `queue`** を第一級で提供する。`tail` は可観測性
  （[ADR-0013](./0013-observability.md)）と連携して次に、`email` はさらに後続で拡充する。

## 結果 (Consequences)

### 良い結果 (Positive)

- 定期実行（Cron Triggers）・非同期ジョブ消費（Queues）・実行イベント収集（Tail）が同一ライブラリ・
  同一 isolate 内で扱え、背景処理のために別 Worker を用意せずに済む。
- Queues の送信側と消費側が揃い、[ADR-0008](./0008-cloudflare-platform-bindings.md) で残っていた欠落が解消される。
- `env` バインディングと可観測性を全入口で共有でき、ジョブと HTTP ハンドラで設定・ログ・例外整形の方針が一致する。
- HTTP 形でない処理に HTTP 形の解釈系を被せないため、型が素直で無駄なオーバーヘッドがない。

### 悪い結果・トレードオフ (Negative)

- 入口ごとに JSFFI バインディングとディスパッチを実装・追従する工数が増える。`MessageBatch` /
  `ScheduledController` / `TailEvent` の各 API 形状を Cloudflare 側の変更に追従して保守する必要がある。
- 公開する export が増えるほどバンドルサイズ（[ADR-0014](./0014-bundle-size-limits-performance.md)）が増える。
  未使用の入口を含めない工夫が要る。
- 単一スレッド RTS のもとで、`fetch` と `scheduled` / `queue` が同一 isolate 上でインターリーブしうる。
  C-FFI 由来の同期コンテキストから async JSFFI を force すると `WouldBlockException` になる境界の注意は
  全入口に及ぶ（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）。
- `queue` の `ack` / `retry` を誤ると、メッセージの重複処理や無限再試行を招く。冪等性の設計責任が利用側に残る。

### 中立・フォローアップ (Neutral / Follow-up)

- `queue` のバッチサイズ・最大再試行回数・デッドレターキューの方針、`scheduled` の重複起動
  （複数 isolate での同時発火）に対する冪等性の指針を別途まとめる。
- `wrangler.toml` の Cron Triggers / Queues consumer 宣言（[ADR-0015](./0015-build-deploy-ci-pipeline.md)）と
  Haskell 側 export の整合を検証する仕組み（命名・存在チェック）を [ADR-0008](./0008-cloudflare-platform-bindings.md) の
  整合検証と合わせて検討する。
- `email` ハンドラと、Durable Objects の `alarm()`（常駐オブジェクト側の入口、
  [ADR-0010](./0010-websockets-durable-objects.md)）の扱いは後続で詳細化する。

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 第一級の型付きハンドラ（`scheduled` / `queue` / `tail` / `email`）

- 利点: Worker の各入口形状に 1:1 対応し、`env` と可観測性を共有しつつ HTTP 形でない処理に適した
  軽量ディスパッチを使える。Queues 消費側の欠落も埋まる。
- 欠点: 入口ごとのバインディング・ディスパッチの実装/追従工数とバンドルサイズ増。

### `fetch` のみ + 背景処理を別 Worker へ

- 利点: 本ライブラリの実装範囲が `fetch` に閉じ、初期工数が小さい。
- 欠点: 定期実行・キュー消費を別 Worker（別言語含む）に分散させると、`env`・ログ・型・デプロイが
  二重化し、Haskell で実運用を完結させる目標に反する。Queues 消費側はそもそも提供できない。

### 外部トリガで Cron を疑似し `fetch` に集約

- 利点: 入口は `fetch` のみで済み、追加実装が要らない。
- 欠点: Cron Triggers / Queues というプラットフォーム機能を使わず外部スケジューラに依存するため、
  信頼性・到達保証・認証境界が外部任せになる。Queues の `MessageBatch` 配信・再試行・バッチ ack は
  HTTP では再現できず、消費側の欠落は解消しない。

## 遵守事項 (Compliance)

- [ ] `scheduled` / `queue`（および対応する場合 `tail` / `email`）は `foreign export javascript` で公開し、
      JS エントリは `export default { fetch, scheduled, queue, tail }` で各 export を呼ぶだけにする。
- [ ] `_initialize` / RTS 初期化は、最初に発火する入口に依らず isolate あたり一度だけ実行する。
- [ ] `scheduled` / `queue` / `tail` には Servant 実行エンジン（[ADR-0006](./0006-servant-execution-engine.md)）を
      流用せず、入口ごとの型付きディスパッチを用いる。
- [ ] 全入口で `env` バインディング（[ADR-0008](./0008-cloudflare-platform-bindings.md)）と可観測性
      （[ADR-0013](./0013-observability.md)）の共通層を再利用する。
- [ ] Queues は送信側（[ADR-0008](./0008-cloudflare-platform-bindings.md)）に加えて消費側 `queue` ハンドラを
      提供し、`wrangler.toml` の consumer 宣言と対応付ける。
- [ ] `queue` ハンドラはメッセージ単位の `ack` / `retry` を型で扱えるようにし、冪等性の前提を文書化する。

## 参考資料 (References)

- Cloudflare Workers — Scheduled Handler（`scheduled(controller, env, ctx)` / `controller.cron` / `scheduledTime` / `noRetry`）: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Cloudflare Workers — Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare Queues — Consumer（`queue(batch, env, ctx)` / `MessageBatch` / `ack` / `retry`）: https://developers.cloudflare.com/queues/configuration/javascript-apis/
- Cloudflare Queues — Configure Queue consumers: https://developers.cloudflare.com/queues/configuration/configure-queues/
- Cloudflare Workers — Tail Workers（`tail(events, env, ctx)`）: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Cloudflare Email Routing — Email Workers（`email(message, env, ctx)`）: https://developers.cloudflare.com/email-routing/email-workers/
- GHC User's Guide — WebAssembly backend（reactor / `_initialize` / JSFFI export / 単一スレッド RTS）: https://downloads.haskell.org/ghc/latest/docs/users_guide/wasm.html
- Haskell Discourse — Serverless Haskell with GHC WASM + JSFFI on Cloudflare Workers: https://discourse.haskell.org/t/serverless-haskell-with-ghc-wasm-jsffi-cloudflare-workers/9784
- konn/ghc-wasm-earthly（設計参照のみ）: https://github.com/konn/ghc-wasm-earthly

## 追補 (2026-07-23): Phase A theme A4 で確定した非 fetch エントリポイントの実装

- ステータス: 承認（追補）
- 日付: 2026-07-23
- 決定者: lihs

Phase A theme A4（Queue producer/consumer・Scheduled・Tail・Service Bindings・DO WebSocket/storage、
実機検証済み）で確定した設計を記録する。本文「決定 (Decision)」節が示した方針（型付きハンドラ、
`fetch` と並べた `foreign export javascript`、`env`/可観測性の共有）を、以下のとおり実装レベルで
具体化する。本文自体は書き換えない。

### 決定 1: 確定シグネチャ — `mkScheduledHandler`/`mkQueueHandler`/`mkTailHandler` は JSVal×3 +
`(BuildBindingEnv, BuildDosEnv)` 制約

各非 fetch ハンドラの marshal 関数は、`mkFetchHandler`（[ADR-0004](./0004-fetch-entrypoint-request-lifecycle.md)）
と「Fetch 同型」の形をとる。

```haskell
mkScheduledHandler
  :: forall kvs dos bindings. (BuildBindingEnv bindings, BuildDosEnv dos)
  => ScheduledHandler (BindingEnv kvs dos bindings) -> JSVal -> JSVal -> JSVal -> IO ()

mkQueueHandler
  :: forall kvs dos bindings. (BuildBindingEnv bindings, BuildDosEnv dos)
  => QueueConsumer (BindingEnv kvs dos bindings) -> JSVal -> JSVal -> JSVal -> IO ()

mkTailHandler
  :: forall kvs dos bindings. (BuildBindingEnv bindings, BuildDosEnv dos)
  => TailHandler (BindingEnv kvs dos bindings) -> JSVal -> JSVal -> JSVal -> IO ()
```

三者とも controller/batch/events・env・ctx の 3 `JSVal` を marshal してハンドラを実行する。
`mkFetchHandler` と異なり戻り値は `IO ()`（応答値が無い）で、`mkScheduledHandler`/`mkQueueHandler` は
**意図的に `Control.Exception.try` で例外を捕捉しない** — Haskell 例外をそのまま伝播させ、GHC の wasm
JSFFI export 機構が返す JS `Promise` を reject させることで、Workers 実プラットフォームの「ハンドラが
投げた/reject した場合、明示的な ack/retry が無ければバッチ全体・呼び出し全体を retry する」意味論を
そのまま利用する。`mkTailHandler` も同様に `try` を持たないが、これは `tail()` には応答値も
「プラットフォームが retry する」意味論も無いため、単に例外を握りつぶす理由が無いという判断。

`export default { fetch, queue, scheduled, tail }` の 4 handler が完成した（`email` は本追補・A4 の
対象外、引き続き follow-up）。

### 決定 2: `ScheduledEvent` → `ScheduledController` への再設計

本文が示した概念シグネチャ `scheduled :: ScheduledController -> Env -> Context -> IO ()` を実装レベルで
確定する。

```haskell
data ScheduledController = ScheduledController
  { scheduledControllerCron :: Text
  , scheduledControllerScheduledTime :: Integer
  , scheduledControllerNoRetry :: IO ()
  }
```

（`Show`/`Eq` 導出なし — `IO` アクションを持つレコードはいずれの型クラスも導出できない）。旧
`data ScheduledEvent = ScheduledEvent { scheduledEventCron :: Text, scheduledEventScheduledTime ::
Double }` は削除、`JSScheduledExport`（一度も実際に構築されなかったプレースホルダ）も削除。

**実測**: `scheduledControllerScheduledTime` は素の JS `number` として届く（実
`ScheduledController#scheduledTime`）。これは Queue の `Message#timestamp`（ネイティブ `Date`、
`.getTime()` 経由で読む）と非対称 — `@cloudflare/vitest-pool-workers` 0.18.7 の
`ScheduledController`/`createScheduledController` 自身のソースを直接確認して確定した（ドキュメントからの
推測ではない）。値は `Integer`（絶対時刻は `Integer` とする裁定、後述の決定 6 参照）— `Double` で
FFI 境界を読んでから `round` する。

### 決定 3: `QueueMessage` record + `ackAll`/`retryAll` + `QueueContentType` 判別共用体

```haskell
data QueueMessage = QueueMessage
  { queueMessageId :: Text
  , queueMessageTimestamp :: Integer         -- 絶対エポックミリ秒 (real Message#timestamp, Date#getTime())
  , queueMessageAttempts :: Int
  , queueMessageBody :: ByteString
  , queueMessageAck :: IO ()
  , queueMessageRetry :: QueueRetryOptions -> IO ()
  }
```

（`Show`/`Eq` 導出なし、同じ理由）。旧 `msg` 型パラメータ（`QueueBatch msg`/`QueueConsumer msg env`）は
削除 — body は実 `contentType` が何であれ常に `ByteString` として届く（`Internal.FFI.Queue` 側の
per-shape decode がその差異を吸収する）。バッチ全体には `queueBatchAckAll`/`queueBatchRetryAll` を提供。

`QueueContentType` は実 API の 4 択に対応する sum 型:

```haskell
data QueueContentType = QueueContentTypeJson | QueueContentTypeText | QueueContentTypeBytes | QueueContentTypeV8
```

**実測**: 実 Queues の default `contentType` は、`compatibility_date` が 2024-03-18 以降の Worker では
`"json"`（`"v8"` ではない）であり、送信した JS 値のランタイム型から推論されることは無い（Cloudflare
公式ドキュメントを Context7 経由で直接確認して確定、推測ではない）。`queueSend`/`queueSendBatch` は
常に生の `ByteString` を取るため、`contentType` を省略して実プラットフォームのデフォルトに任せると、
意図したバイト列ではなくバイト値の配列が JSON シリアライズされてしまう。そのため
`QueueSendOptions.queueSendOptionsContentType = Nothing` は実プラットフォームの現行デフォルト
（`"json"`）では**なく**、常にワイヤータグ `"bytes"` に解決するよう実装した（明示的な省略はしない、
A4 plan の「queueSend bytes 主」裁定）。

at-least-once 配送を前提に、`queueDedupCheck :: KV -> Text -> IO Bool` を `message.id` ベースの
dedup ヘルパとして提供する（ベストエフォート、"check してから write" の非アトミック操作であり厳密な
exactly-once ではない）。既存の任意の `KV` binding 上に構築でき、Queue 専用の binding は不要。

### 決定 4: Tail は配列型 `[TailEvent]`（単数から change）

```haskell
data TailEvent = TailEvent
  { tailEventScriptName :: Maybe Text
  , tailEventOutcome :: Text
  , tailEventEventTimestamp :: Maybe Integer
  }
  deriving stock (Show, Eq)

type TailHandler env = [TailEvent] -> env -> Ctx -> IO ()
```

旧型は `data TailEvent = TailEvent { tailEventScriptName :: Text, tailEventOutcome :: Text }`
（両方必須）+ 単数形 `TailEvent -> env -> Ctx -> IO ()` だった。実ネイティブの `tail(events, env,
ctx)` の第一引数は本質的に配列（1 回の呼び出しで複数の trace item を運びうる）であり、単数形状では
正しくモデル化できない。`tailEventScriptName`/`tailEventEventTimestamp` は防御的に `Maybe`（手組みの
フィクスチャや退化した実 trace item が省略しうる）。フィールドは最小 3 個（`scriptName`/`outcome`/
`eventTimestamp`）に留める意図的判断 — 実 `TraceItem` は `logs`/`exceptions`/
`diagnosticsChannelEvents`/`event`/`executionModel` 等さらに多くのフィールドを持つが、これらを読む
ことは本 Unit のスコープ外、拡張は明示的な follow-up として記録するに留めた。

### 決定 5: DO entrypoint = JS glue class への委譲、Haskell 側は stateless

Durable Object のクラス自体（`extends DurableObject`）は JS 側の薄い glue（本文が想定した「JS の薄い
エントリ」の実体）が担い、その `fetch`/`webSocketMessage`/`webSocketClose` メソッドが wasmExports の
対応する `foreign export` へ委譲する。Haskell 側は stateless — `ctx`/`env` はメソッド呼び出しの
たびに引数として渡され、Haskell 側では保持しない。

**実測 footgun**: Durable Object の RPC stub（`doCall`）・Service Binding の RPC stub
（`serviceCall`）はいずれも JS 側で Proxy-backed なオブジェクトとして実装されており、
`Function.prototype.apply` は使えない — `stub[methodName](...args)` のような spread-call 構文が
必須（`.apply` 経由の呼び出しは動作しない）。これは `doCall`/`serviceCall` の双方で確認した実測結果。

### 決定 6: 絶対時刻 Integer / 相対値 Int の型規約（[ADR-0008](./0008-cloudflare-platform-bindings.md)
追補への cross-ref）

本 ADR が新設した非 fetch エントリポイントのフィールドも、[ADR-0008](./0008-cloudflare-platform-bindings.md)
追補（A3 分「決定 8」）が確立した規約に従う: **絶対時刻は `Integer`、相対値・件数は `Int` のまま**。

- 絶対時刻（`Integer`）: `scheduledControllerScheduledTime`（エポックミリ秒）、`queueMessageTimestamp`
  （エポックミリ秒）、`tailEventEventTimestamp`（エポックミリ秒）
- 相対値・件数（`Int` のまま）: `QueueRetryOptions`/`QueueSendOptions.queueSendOptionsDelaySeconds`
  （現在時刻からの相対秒数）

根拠は [ADR-0008](./0008-cloudflare-platform-bindings.md) 追補と同一（`wasm32-wasi` の GHC は `Int` が
32-bit、エポックミリ秒値は既に 2^31 を超える）。FFI 境界自体は `Double` を経由し、読み取り時に
`round` で `Integer` へ変換する。

### 実測で確定した挙動（記録）

- `-optl-Wl,--export=queue`/`--export=scheduled`/`--export=tail` のようなリンカフラグは不要
  （`foreign export javascript` 関数は明示的な `--export=<name>` を要求しないという既存の知見が
  queue/scheduled/tail でも再確認された）。
- 自己参照の `[[services]]`（同一 Worker 自身を `service` とする Service Binding）は
  `@cloudflare/vitest-pool-workers` 0.18.7 上で補助 Worker 無しに解決可能（miniflare は
  `wrangler.toml` の `name` で 1 つの worker インスタンスを登録し、同名を指す `[[services]]` は
  その実行中インスタンスへ解決する）。
- ローカル harness（vitest サンドボックス）では実 Queues の producer→consumer 自動配信が観測不能
  （時間凍結アーティファクト）。`wrangler dev` でも `/cdn-cgi/handler/*` は `scheduled`/`email` のみ
  対応しており Queue の手動トリガ経路が無いため代替不可 — 2 つの独立した否定的確認（`wrangler`
  自身の CLI ソースの静的解析 + 実 `curl` 往復）で結論した。
- `retry(delaySeconds)` の実効値は `@cloudflare/vitest-pool-workers` 0.18.7 の `getQueueResult` が
  追跡しない（retry が要求されたことは検証できるが、渡した `delaySeconds` の値そのものは検証不能）。

### 遵守事項への影響（本文 override）

- 「各入口に対応する Haskell ハンドラを定義し、`foreign export javascript` で `fetch` と並べて
  公開する」→ 追補により `mkScheduledHandler`/`mkQueueHandler`/`mkTailHandler` の実シグネチャを確定
  （決定 1）。`email` は引き続き未実装。
- 「Queues の消費側という現状の欠落を埋める」→ 追補により `QueueMessage`/`mkQueueHandler` が実配線
  済み。ただし consumer concurrency・実 Queues 配信の実機挙動検証はローカル harness の権限外
  （[ADR-0020](./0020-cloudflare-verification-cycle.md) の RE = Non-goal）。

### 参考資料（追補分）

- [ADR-0008](./0008-cloudflare-platform-bindings.md) 追補（A3 分・A4 分。timestamp/相対値の型規約、
  `dos` slot 実体化）
- Cloudflare Queues — Consumer concepts（`contentType` のデフォルト）: 本文の Queues Consumer
  参照（https://developers.cloudflare.com/queues/configuration/javascript-apis/）を Context7 経由で
  再確認
- 実装詳細・実機検証ログ: `~/.pschool/spikes/cloudflare-workers-hs-build/_phase_a/a4-plan.md`、
  `_phase_b/divergence-notes.md`「A4 batch 3」「A4 batch 4」節、`API-LEDGER.md` 該当節

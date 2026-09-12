# WebSocketチャットとDurable Object SQL

独立したNamedRoutes HTTP Workerが `/rooms/:room/connect` を同名のDurable Objectへ渡します。
各RoomはSQLiteの履歴とWebSocket attachmentを正本にし、プロセス共通のMapやIORefへ接続状態を保存しません。
TypeScriptはWASM初期化、DO constructor／fetch／message／close／errorの配線だけを担当します。

```sh
just setup-js
bash examples/realtime/scripts/build.sh
node --test examples/realtime/test/integration/realtime.spec.mjs
cd examples/realtime
../quickstart/node_modules/.bin/wrangler dev --local
```

ブラウザのコンソール等から接続できます。

```js
const socket = new WebSocket("ws://localhost:8787/rooms/general/connect");
socket.onmessage = event => console.log(event.data);
socket.onopen = () => {
  socket.send("こんにちは");
  // 自動応答はDOを起こさず、履歴にも加算しない。
  socket.send("ping"); // pong
};
```

`GET /rooms/general/history` は最新100件を新しい順で返します。
`GET /rooms/general/connections` は接続数、復元可能なattachment、constructor実行回数を返します。
テキスト・バイナリを保存して参加者へ配信し、4096バイトを超えるフレームはWASMへコピーする前に拒否します。
この公開チャット例には管理認証を設けていません。転送用Quickstartの認証APIとは別アプリです。

## 同期SQLの契約

公開 `Cloudflare.Workers.Binding.DurableObject.SQL` の `sqlExecute`／`sqlBatch` は
null・有限で安全に表現できるnumber・text・blobを型で扱います。
Haskellが作ったSQLとパラメータの計画を、単一のネイティブ`transactionSync`内で実行します。
カーソルは同期的に全消費してから返し、Haskell callbackやカーソルをawait越しに保持しません。
失敗したバッチと出力制限に達したバッチは全体をロールバックします。

既定値は32 statements、1000 rows、入出力ペイロード1 MiBです。
入出力バイト数とJSON展開前の入力見積もりを制限し、blob・文字列の無制限なWASM転送を避けます。
これらは返却データの制限であり、任意SQLのCPU時間やSQLite自身の作業メモリを制限する機構ではありません。
SQL文はアプリ所有の固定文を用い、外部入力はパラメータに渡してください。
SQL文中に複数statementを含めると、Cloudflareの仕様上パラメータと返却cursorは最後のstatementに対応します。
複数操作の結果を必要とする場合は`sqlBatch`の別々の要素にします。

## 検証済みの境界

- 実workerdのSQLite型変換、パラメータ安全性、バッチ失敗と行上限時の原子ロールバック、バイト上限。
- 実HTTP 101接続、複数クライアントのテキスト・バイナリ配信、attachment、close、部屋分離。
- native hibernation：外部クライアントで12秒待機し、同じ接続で送受信を継続。
  SQLに保存したconstructor回数が増加し、同じattachmentと履歴が残ることを確認。
  constructorを手動で呼ぶ模擬テストではありません。
- WebSocketのネイティブ自動応答、外側HTTPヘッダーの維持、101を別statusへ変更した応答の拒否。
- 入力・WASM・glueのSHA-256鮮度検査。別のDO／RPC fixtureは`test/Support/**`に限定。

互換日付は同梱workerdがサポートする最新の`2026-08-06`です。
参考：[SQLと同期カーソル](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)、
[10秒の休止条件](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)。

## Addressing rooms and controlling WebSockets

`POST /rooms` allocates a new unique Durable Object identifier and returns
`{"identifier":"<64 hexadecimal digits>"}`. Retain this value and connect via
`/room-identifiers/<identifier>/connect`; history and connection endpoints use
that same prefix. The Haskell path uses `doNewUniqueID`, `doIDToString`,
`doIDFromString`, and `doGet`. Invalid identifiers return 400. Each POST creates
a distinct identifier: retrying creation is not idempotent. Existing
`/rooms/<name>/…` routes continue to address rooms deterministically by name.

`PUT /rooms/<name>/auto-response` accepts JSON `false` to remove automatic
ping/pong responses (`webSocketSetAutoResponse Nothing`) or `true` to restore
them. The choice is persisted and reapplied on reconstruction. When disabled,
`ping` goes through the normal Haskell message handler and SQL history; when
enabled, native `pong` bypasses that handler.

`/rooms/<name>/monitor` opens a separately tagged connection for connection
inventory; it does not receive chat broadcasts and cannot publish. The existing
`connections` endpoint selects the `chat` tag. `all-connections` uses
`webSocketConnections Nothing` and includes both tags. This is a local demo,
not an authorization boundary: administrative routes need authentication before
public deployment.

Tests cover unique identifier round-tripping and room isolation, automatic
response removal/restoration, tag isolation, all-tag enumeration, missing or
wrongly typed attachments, and recovery with a fresh connection. Invalid
attachments close with 1008 before writing messages. SQL regression fixtures in
`test/Support/SQLFixture.hs` also reject statement-count overflow, invalid limits,
empty SQL, excessive parameter counts/bytes, NaN and Infinity and verify normal
queries remain usable. Identifier serialization captures native exceptions and
invalid native return values as `DurableObjectIDSerializationFailed`.

Cloudflare documents the identifier format and namespace restoration in
[Durable Object IDs](https://developers.cloudflare.com/durable-objects/api/id/)
and [namespace operations](https://developers.cloudflare.com/durable-objects/api/namespace/).
The [state API](https://developers.cloudflare.com/durable-objects/api/state/)
defines all-tag enumeration and removal of automatic responses by omitting the
request/response pair; the Haskell `Nothing` branch maps to that native omission.

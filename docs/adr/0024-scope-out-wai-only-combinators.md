# ADR-0024: servant の HttpVersion / IsSecure / RemoteHost / Vault を Workers 上ではスコープ外とする

- ステータス: 承認
- 日付: 2026-07-25
- 決定者: lihs（Phase A 受入チェックリスト ★要判断 3 の裁定、2026-07-25）
- 関連: [ADR-0005](./0005-http-layer-no-wai.md)（HTTP 層は WAI を介さない — 本 ADR の直接の根拠）、[ADR-0006](./0006-servant-execution-engine.md)（Servant 解釈系の自前実装 — combinator 集合の所在）、[ADR-0008](./0008-cloudflare-platform-bindings.md)（プラットフォームバインディング）、[ADR-0012](./0012-middleware-equivalents.md)（ミドルウェア相当機能 — `Vault` の代替経路）、Phase A 受入チェックリスト項目 3 / `_phase_a/a2-plan.md` 裁定 6

## 背景と課題 (Context)

`servant`（core）は API 型に置ける combinator として `HttpVersion` / `IsSecure` /
`RemoteHost` / `Vault` の 4 種を提供する。本ライブラリは
[ADR-0006](./0006-servant-execution-engine.md) に従い servant の型レベル DSL を再利用しつつ
サーバ解釈系（`HasWorkerServer`）を自前実装しているため、この 4 種を実装するかどうかは
明示的な判断を要する。

**4 種はいずれも WAI `Request` のフィールドを handler へ素通しするだけの combinator である。**
`servant-server-0.20.3.0` の `src/Servant/Server/Internal.hs` を一次ソースとして確認した
（L879-907）:

| combinator | `ServerT` の型 | route 実装 |
|---|---|---|
| `RemoteHost` | `SockAddr -> ServerT api m` | `passToServer subserver remoteHost` |
| `IsSecure` | `IsSecure -> ServerT api m` | `passToServer subserver (\req -> if isSecure req then Secure else NotSecure)` |
| `Vault` | `Vault -> ServerT api m` | `passToServer subserver vault` |
| `HttpVersion` | `HttpVersion -> ServerT api m` | `passToServer subserver httpVersion` |

`remoteHost` / `isSecure` / `vault` / `httpVersion` はすべて `Network.Wai.Request` の
フィールドアクセサである。本ライブラリは [ADR-0005](./0005-http-layer-no-wai.md) で WAI を
介さないことを決めており、同 ADR の遵守事項は「HTTP 層は `wai`/`warp`/`network` へ依存しない」
と明記している。したがってこの 4 種には、供給元となる構造体そのものが存在しない。

Workers 側（Fetch API の `Request`）が公開するプロパティは
`body` / `bodyUsed` / `cf` / `headers` / `method` / `redirect` / `signal` / `url` の 8 つで
（Cloudflare 公式 docs、下記「参考資料」）、**プロトコルバージョン・接続の TLS 有無・
クライアント IP・リクエストスコープの汎用ストアに相当するプロパティは 1 つも無い**。
本ツリーの `Cloudflare.Workers.HTTP.Request` も
`requestMethodField` / `requestURLField` / `requestBodyField` / `requestHeaders` /
`requestBodyReaderField` の 5 フィールドで、対応物を持たない。

Phase A 受入チェックリスト項目 3 の当初提案は「API-LEDGER 準拠の最小 mapping
（`IsSecure` = 常に `True` 等）を実装し文書化」だった。実際には A2 で不実装のまま進み、
`_phase_a/a2-plan.md` の裁定 6 が「HttpVersion/IsSecure/RemoteHost/Vault は不実装」と閉じた
一方、チェックリストは同じ項目を未決の★要判断として残置したため、**2 つの文書が異なる状態を
主張していた**。本 ADR はこの食い違いを決定として確定させ、両文書を本 ADR へ揃える。

## 決定要因 (Decision Drivers)

- [ADR-0005](./0005-http-layer-no-wai.md) の遵守事項「HTTP 層は `wai`/`warp`/`network` へ
  依存しない」を破らないこと
- 型が持つ情報量に嘘をつかないこと（分岐の余地が無い定数を、値を運ぶ combinator の形で
  出荷しない）
- Workers 上で等価の情報に到達する経路が既に存在するなら、それを Cloudflare 固有だと分かる
  場所に置くこと
- 未使用の抽象を bundle と CPU 予算（[ADR-0014](./0014-bundle-size-limits-performance.md)）に
  持ち込まないこと

## 検討した選択肢 (Considered Options)

1. 最小 mapping を実装する（`IsSecure` = 常に `Secure`、`HttpVersion` = `cf.httpProtocol` の
   解釈、`RemoteHost` = `CF-Connecting-IP` ヘッダ、`Vault` = 空の `Vault`）
2. **スコープ外とし、等価情報は Workers 固有の経路（`cf` プロパティ / Cloudflare ヘッダ /
   servant `Context` / Tier1 middleware）で表現する**
3. 4 種を型レベルで明示的に拒否する（インスタンスを書き、`TypeError` でコンパイル時に
   理由付きで落とす）

## 決定 (Decision)

採用する選択肢: **選択肢 2（スコープ外で確定）**

`HasWorkerServer` は `HttpVersion` / `IsSecure` / `RemoteHost` / `Vault` のインスタンスを
定義しない。combinator ごとの根拠と代替表現は次のとおり。

### HttpVersion

WAI では `httpVersion :: Request -> HttpVersion`（`http-types` の major/minor 対）。
Workers の `Request` にプロトコルバージョンのプロパティは無い。**等価情報は
`request.cf.httpProtocol`** で、公式 docs が `IncomingRequestCfProperties` の
フィールドとして列挙している。本プロジェクトの実 edge 計測でも実在を確認済み
（`_phase_a/a8-re1-artifacts/tail-full.json` L77 `"httpProtocol": "HTTP/2"`）。

ただし `cf.httpProtocol` は `"HTTP/2"` のような**文字列**であって `HttpVersion` の
major/minor 構造ではない。型を合わせるには文字列 → `HttpVersion` の解釈を挟むことになり、
その値域は実測で列挙されていない。`cf` 由来であることが型名から分かる Workers 固有
accessor のほうが、servant の型を借りて出自を隠すより正直である。

### IsSecure

WAI では `isSecure :: Request -> Bool`。servant 自身の Haddock
（`src/Servant/API/IsSecure.hs`）が「これはクライアントが元々 SSL で接続したかではなく
**現在の接続が SSL か**を示す。リバースプロキシで差が出る」と注意している。

Workers のハンドラは Cloudflare edge が TLS を終端した後に呼ばれるため、素直な mapping は
**常に `Secure`** という定数になる。定数を返す combinator は分岐の余地が無く、
型が情報を運んでいるように見せかけるだけで、読み手を誤らせる。

クライアント側スキームを本当に知りたい場合の等価情報は 2 つある: Cloudflare が付与する
`CF-Visitor` ヘッダ（公式 docs いわく「`scheme` という単一キーを持つ JSON オブジェクト」。
実測でも `"cf-visitor": "{\"scheme\":\"https\"}"` を確認、同 artifact L67）と、
`request.url` のスキーム。いずれもヘッダ/URL として既に到達可能で、新しい combinator を
要さない。

### RemoteHost

servant-server の型は `SockAddr -> ServerT api m` で、`SockAddr` は `network` パッケージの
`Network.Socket` に由来する。`network` は `wasm32-wasi` でビルドできず
（[ADR-0005](./0005-http-layer-no-wai.md) 背景節）、同 ADR の遵守事項がその依存を明示的に
禁じている。**`SockAddr` を使う限り実装は ADR-0005 違反になり、`SockAddr` を使わない別型で
提供すれば servant-server 互換ではなくなる**（`ServerT` の型が本家と違えば、本家向けに
書かれた handler はそのまま載らない）。

等価情報は `CF-Connecting-IP` ヘッダで、公式 docs が「Cloudflare へ接続しているクライアントの
IP アドレスをオリジンに提供する」と定義している。実測でも実在を確認済み（同 artifact L65）。
ただし A8 セキュリティレビュー領域 2（header trust boundary）は現在
「`cf-connecting-ip` 等を読むコードがそもそも無い」ことを mitigation の根拠にしているため、
読む口を開けるならヘッダ信頼境界の決定が先に要る。

### Vault

WAI の `vault :: Request -> Vault` は、**middleware とアプリケーションが任意データを共有する
ための型無しストア**である（servant の Haddock も「middlewares and applications が
arbitrary data を store する共有場所」と説明する）。本スタックに WAI middleware は存在しない。

同じ目的の口は既に 2 つあり、どちらも型付きである:

- **静的・型付きの注入** = servant `Context` と `WithNamedContext`（実装済み。
  Access verifier の注入がこの経路を使っている）
- **リクエストごとの動的な注入** = `Cloudflare.Workers.Middleware` の Tier1 変換
  （[ADR-0012](./0012-middleware-equivalents.md)。実装済みの `withRequestId` は
  リクエスト id をこの層で注入し、`withStructuredLogging` がそれを読む）

型無しの `Vault` を足すと、既存の型付き 2 経路と競合する 3 本目の経路になる。

## 結果 (Consequences)

### 良い結果 (Positive)

- ADR-0005 の遵守事項（`network` 非依存）を破らずに済む。`RemoteHost` は選択肢 1 を採ると
  必ずこれに抵触した
- 分岐の余地の無い定数（`IsSecure` = 常に `Secure`、空の `Vault`）を、値を運ぶ combinator の
  形で出荷しない
- 4 種の等価情報が「Cloudflare 固有である」と分かる場所（`cf` プロパティ / `CF-*` ヘッダ /
  `Context` / Tier1 middleware）に置かれ、servant の型が出自を隠さない

### 悪い結果・トレードオフ (Negative)

- 既存の servant API 型をそのまま移植する利用者が、この 4 種を含む型では本ライブラリで
  コンパイルできない。エラーは「該当インスタンスが無い」という素の型エラーで、**理由は
  示されない**（選択肢 3 を採らなかったコスト）
- `request.cf` の typed accessor がまだ無いため、現時点で `HttpVersion` 相当の情報に
  ライブラリ利用者は到達できない（`RemoteHost` / `IsSecure` 相当はヘッダ経由で到達可能）

### 中立・フォローアップ (Neutral / Follow-up)

- `request.cf` の typed accessor を提供するかは本 ADR の範囲外。提供するなら
  [ADR-0008](./0008-cloudflare-platform-bindings.md) の env binding とは別レイヤ
  （リクエスト由来）として別途決定する
- `CF-Connecting-IP` 等の Cloudflare ヘッダを読む API を公開するなら、A8 セキュリティ
  レビュー領域 2（header trust boundary）の決定が先行する

### 将来実装する場合の条件 (再検討トリガ)

本 ADR は封殺ではない。次のいずれかが満たされたとき、当該 combinator について再検討する。

1. **IsSecure** — Workers 上で `NotSecure` を返しうる実経路が実在することを実測で示せたとき。
   示せない限り実装は定数であり、combinator の形を取る意味が無い
2. **HttpVersion** — `request.cf.httpProtocol` の typed accessor が入り、その文字列の値域が
   実測で列挙できたとき（`HTTP/1.1` / `HTTP/2` / `HTTP/3` 等）。あわせて、`cf` が
   `wrangler dev`（T2）で実 edge と同じ値を持つかを確認し、検証層を明記すること
3. **RemoteHost** — header trust boundary（セキュリティレビュー領域 2）の決定が先に入り、
   かつ `network` に依存しない型（`SockAddr` ではない）で提供することを
   [ADR-0006](./0006-servant-execution-engine.md) の互換方針が許容すると裁定されたとき
4. **Vault** — 型無しのリクエストスコープ共有ストアが必要になる具体的ユースケースが現れ、
   servant `Context` と Tier1 middleware のどちらでも表現できないと示されたとき

## 各選択肢の利点・欠点 (Pros and Cons of the Options)

### 選択肢 1: 最小 mapping を実装する

- 利点: servant の既存 API 型がそのまま載る。移植時の書き換えが不要
- 欠点: `RemoteHost` は `SockAddr` を要求するため `network` 依存が要り、ADR-0005 の遵守事項に
  抵触する。`IsSecure` と `Vault` は定数（常に `Secure` / 常に空）にしかならず、型が情報を
  運ぶように見せて実際は運ばない。`HttpVersion` は `cf.httpProtocol` の文字列を値域未確認の
  まま構造化することになる

### 選択肢 2: スコープ外とし、等価情報は Workers 固有の経路で表現する（採用）

- 利点: ADR-0005 を破らない。嘘をつく型を出荷しない。等価情報の出自が呼び出し側から見える
- 欠点: 既存 servant API 型の移植時に書き換えが要る。型エラーは理由を示さない

### 選択肢 3: 型レベルで明示的に拒否する（`TypeError` インスタンス）

- 利点: 選択肢 2 の唯一の欠点（理由の見えない型エラー）を解消し、「なぜ使えないか・何を
  使うべきか」をコンパイルエラーの本文で伝えられる
- 欠点: 4 種のためだけに `TypeError` インスタンスを 4 本抱えることになり、`ServerT` の型族
  インスタンスも必要になる（型族は `TypeError` だけでは閉じない）。将来実装に転じる際、
  拒否インスタンスの撤去が破壊的変更として観測される。**今回は採らないが、利用者からの
  混乱が実際に報告された場合の第一候補として記録する**

## 遵守事項 (Compliance)

- [ ] `servant-cloudflare-workers` は `HasWorkerServer (HttpVersion :> api)` /
      `(IsSecure :> api)` / `(RemoteHost :> api)` / `(Vault :> api)` のインスタンスを定義しない
- [ ] `cloudflare-workers` / `servant-cloudflare-workers` は `network` に依存しない
      （[ADR-0005](./0005-http-layer-no-wai.md) 遵守事項の再掲。`RemoteHost` を実装すると
      抵触するため、本 ADR の実効的なゲートでもある）
- [ ] Phase A 受入チェックリスト項目 3 の当該行と `_phase_a/a2-plan.md` の裁定 6 が、
      いずれも「スコープ外で確定（ADR-0024）」と読めること（2 文書の食い違いを再発させない）

## 参考資料 (References)

- `servant-0.20.3.0` — `src/Servant/API/HttpVersion.hs` / `IsSecure.hs` / `RemoteHost.hs` /
  `Vault.hs`（各 combinator の定義と Haddock。`IsSecure` の「現在の接続が SSL か」注意書き、
  `RemoteHost` の `SockAddr` 指定、`Vault` の「middleware と application の共有ストア」説明）
- `servant-server-0.20.3.0` — `src/Servant/Server/Internal.hs` L879-907（4 種の `HasServer`
  インスタンスがいずれも WAI `Request` フィールドの `passToServer` であること）
- `servant-0.20.3.0` の `servant.cabal` — `http-types` / `vault` には依存するが `network` には
  依存しない（`network-uri` のみ）。`SockAddr` を要求するのは servant-server 側
- Cloudflare Docs — Workers Runtime API / Request:
  <https://developers.cloudflare.com/workers/runtime-apis/request/>
  （`Request` の公開プロパティ 8 種と `IncomingRequestCfProperties` の
  `httpProtocol` / `tlsVersion` / `tlsCipher` ほか）
- Cloudflare Docs — HTTP request headers:
  <https://developers.cloudflare.com/fundamentals/reference/http-headers/>
  （`CF-Connecting-IP` = クライアント IP、`CF-Visitor` = `scheme` を持つ JSON、`CF-Ray`、
  `CF-IPCountry`）
- 実 edge 実測（Phase A spike tree）— `_phase_a/a8-re1-artifacts/tail-full.json` L65-135:
  `cf-connecting-ip` / `cf-visitor` ヘッダの実在と、`cf.httpProtocol = "HTTP/2"` /
  `cf.tlsVersion` / `cf.tlsCipher` / `cf.colo` 等を含む `cf` オブジェクトの実キー集合
- 本ツリー — `cloudflare-workers/src/Cloudflare/Workers/HTTP.hs`（`Request` の 5 フィールド）、
  `cloudflare-workers/src/Cloudflare/Workers/Internal/FFI/Request.hs`
  （読み取っているのは `.method` / `.headers` / `.body` のみ）

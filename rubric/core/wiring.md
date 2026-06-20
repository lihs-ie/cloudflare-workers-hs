# 配線ミス検出 rubric (core / 言語不受)

runtime-verifier が使う。「コードが存在する」ではなく「入口から出口までの経路が
**実行で証明された**か」を yes/no で判定する。各項目は機械検証可能な証拠を必須とする。

| 判定項目 | チェック内容 | 必要証拠 |
|---|---|---|
| 入口接続 | UI 操作 / CLI / HTTP route / job scheduler / event publish のいずれかが feature 入口として登録されているか | route 一覧 / UI test step / CLI help / job 定義 |
| 中継接続 | controller/handler から service/usecase へ **実呼び出し** があるか | grep/call graph / unit・feature test / 実行ログ |
| 出口接続 | repository / external adapter / queue / DB write / UI state update のいずれかが実際に呼ばれたか | DB state diff / contract result / UI assertion (HTTP mock ではなく) |
| 設定接続 | env/config/DI registration/feature flag が正しい値で配線されるか | config 読み込みログ / container binding / 起動ログ |
| 起動可能性 | app が起動し、該当経路で例外なく流れるか | smoke test / healthcheck / trace |
| 逆流防止 | 途中レイヤの依存方向が壊れていないか | structural test / custom lint |
| 回帰防止 | 既存経路を壊していないか | relevant regression suite |
| 目視不要 | 「人が読めば分かる」ではなく、機械検証だけで yes/no 判定できるか | pass/fail を返すコマンド一式 |

## 明示的に fail とする配線ミス例
- route 未登録 / handler から usecase を呼んでいない / DI container 未登録
- feature flag が常に off / migration 未適用
- フロント操作後に network request が飛ばない / 成功 toast だけ出て persistence されない
- event は publish するが consumer がいない

> 「成功 toast が出る」は証拠にならない。**reload 後 / read-back / DB state diff** まで確認する。

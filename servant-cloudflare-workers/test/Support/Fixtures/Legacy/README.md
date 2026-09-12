# 旧テストデータ

旧 `test/golden/` から配置を移した履歴資料です。旧suiteは未登録で、
例えば404.jsonの本文は現行JSONエンベロープ仕様と異なるため、期待値としては使用しません。
現行の独自エラー仕様は `ErrorSpec`、参照実装の50ケースは
`conformance-oracle/test/Support/Golden/reference.json` で検証します。

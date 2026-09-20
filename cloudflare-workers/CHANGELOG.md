# Changelog for `cloudflare-workers`

## 0.1.0.0 — unreleased

- SQLite-backed DOの公式`storage.transaction`をHaskellから利用する`doStorageTransactionWith`と、native例外を保持する`DurableObjectTransactionError`を追加した。既存の固定KV操作列APIは変更しない。
- `sqlExec`は`transactionSync`を追加せず公式`storage.sql.exec`を呼び出す。既存の`sqlExecute`・`sqlBatch`の原子性は維持する。
- DOの公開APIに`doStorageGetAlarm`を追加した。

- `doIDToString`と`DurableObjectIDSerializationFailed`を追加した。DO識別子を文字列として保存・復元でき、不正なnative値や例外は型付きエラーになる。

- KVの公開APIをADTベースへ統一した。`kvGet`、`kvGetWithMetadata`、`kvPut`が読み取り形式・オプション・値形式を直接受け取り、ByteString固定の旧FFIラッパーと型付き別名を削除した。
- R2の公開APIをADTベースへ統一した。`r2Put`、`r2Get`、`r2List`が値形式と完全なオプションを直接受け取り、`Extended`および旧引数分割APIを削除した。

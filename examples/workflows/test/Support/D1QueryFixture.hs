module Support.D1QueryFixture (runD1QueryFixture) where
import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query
import Control.Exception (try)
import Control.Monad (void)
import Data.Aeson (Value, object, (.=))
import Data.ByteString qualified as Bytes
import Data.Text (Text)

runD1QueryFixture :: D1 -> IO Value
runD1QueryFixture database = do
    void $ d1Execute database (D1Statement "CREATE TABLE IF NOT EXISTS typed_query_items(name TEXT PRIMARY KEY, note TEXT, count INTEGER, payload BLOB)" [])
    void $ d1Execute database (D1Statement "DELETE FROM typed_query_items" [])
    let quoted = "quoted-' ; DROP TABLE typed_query_items; --" :: Text
        insert name note count bytes = D1Statement "INSERT INTO typed_query_items(name, note, count, payload) VALUES (?, ?, ?, ?)"
            [D1Text name, note, D1Integer count, D1Blob bytes]
    results <- d1ExecuteBatch database [insert quoted D1Null 7 "\NUL\255", insert "second" (D1Text "present") 8 "a"]
    rows <- d1Query database (D1Statement "SELECT name, note, count, payload FROM typed_query_items ORDER BY count" [])
        ((,,,) <$> d1Column "name" d1Text <*> d1Column "note" (d1Nullable d1Text)
               <*> d1Column "count" d1Integer <*> d1Column "payload" (Bytes.unpack <$> d1Blob))
    first <- d1QueryFirst database (D1Statement "SELECT count FROM typed_query_items WHERE name = ?" [D1Text quoted]) (d1Column "count" d1Integer)
    absent <- d1QueryFirst database (D1Statement "SELECT count FROM typed_query_items WHERE name = ?" [D1Text "absent"]) (d1Column "count" d1Integer)
    failedBatch <- try @D1ExecutionError (d1ExecuteBatch database [insert "must-rollback" D1Null 9 "", insert quoted D1Null 10 ""])
    case failedBatch of
        Left (D1ConstraintViolation _) -> pure ()
        _ -> fail "native D1 batch did not preserve constraint error"
    rolledBack <- d1QueryFirst database (D1Statement "SELECT count FROM typed_query_items WHERE name = ?" [D1Text "must-rollback"]) (d1Column "count" d1Integer)
    missing <- decodingFailure "SELECT 1 AS other" (d1Column "count" d1Integer)
    nullValue <- decodingFailure "SELECT NULL AS count" (d1Column "count" d1Integer)
    wrongType <- decodingFailure "SELECT 'sensitive' AS count" (d1Column "count" d1Integer)
    unsafeInteger <- decodingFailure "SELECT 9007199254740993 AS count" (d1Column "count" d1Integer)
    exactLargeInteger <- d1QueryFirst database (D1Statement "SELECT CAST(9007199254740993 AS TEXT) AS count" []) (d1Column "count" d1Text)
    unsafeParameter <- try @D1QueryError (d1Execute database (D1Statement "INSERT INTO typed_query_items(name, count) VALUES (?, ?)" [D1Text "unsafe", D1Integer 9007199254740993]))
    let parameterRejected = case unsafeParameter of Left (D1InvalidParameter 2 _) -> True; _ -> False
    pure (object
        [ "batchCount" .= length results, "rows" .= rows, "first" .= first, "absent" .= absent
        , "rolledBack" .= rolledBack, "missing" .= missing, "null" .= nullValue, "wrongType" .= wrongType
        , "unsafeInteger" .= unsafeInteger, "exactLargeInteger" .= exactLargeInteger, "unsafeParameterRejected" .= parameterRejected ])
  where
    decodingFailure sql decoder = do
        result <- try @D1QueryError (d1Query database (D1Statement sql []) decoder)
        case result of
            Left error' -> pure (show error')
            Right _ -> fail "expected typed D1 decoding failure"

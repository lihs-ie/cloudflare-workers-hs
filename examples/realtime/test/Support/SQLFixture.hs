module Support.SQLFixture (sqlChecks) where
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Binding.DurableObject.SQL
import Control.Exception (try)
import Control.Monad (void)
import Data.Aeson
import Data.ByteString qualified as Bytes
import Data.Text (Text)
-- Real SQL regression, invoked only by the test subclass's RPC bridge.
sqlChecks :: DurableObjectStorage -> IO Value
sqlChecks storage = do
  void $ sqlExecute storage sqlDefaultLimits (SQLStatement "CREATE TABLE IF NOT EXISTS checks (identifier INTEGER PRIMARY KEY, value TEXT)" [])
  typed <- sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT ? AS null_value, ? AS number, ? AS text, ? AS binary" [SQLNull, SQLNumber 1.25, SQLText "'; DROP TABLE checks; --", SQLBlob (Bytes.pack [0,128,255])])
  rolledBack <- try @SQLError $ sqlBatch storage sqlDefaultLimits
    [SQLStatement "INSERT INTO checks VALUES(1,'must rollback')" [], SQLStatement "INSERT INTO missing_table VALUES(1)" []]
  count <- sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT COUNT(*) AS count FROM checks" [])
  limit <- try @SQLError $ sqlBatch storage sqlDefaultLimits{maximumRows = 1}
    [ SQLStatement "INSERT INTO checks VALUES(2,'rollback on output limit')" []
    , SQLStatement "SELECT 1 UNION ALL SELECT 2" []
    ]
  afterLimit <- sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT COUNT(*) FROM checks" [])
  byteLimit <- try @SQLError $ sqlExecute storage sqlDefaultLimits{maximumBytes = 256} (SQLStatement "SELECT zeroblob(1024)" [])
  inputChecks <- traverse (\(name, limits, statements) -> do
    result <- try @SQLError (sqlBatch storage limits statements)
    pure (object ["name" .= name, "rejected" .= isError result]))
    [ ("maximumStatements" :: Text, sqlDefaultLimits{maximumStatements=1}, [SQLStatement "INSERT INTO checks VALUES(3,'must not run')" [], SQLStatement "SELECT 1" []])
    , ("invalidLimits", sqlDefaultLimits{maximumRows=(-1)}, [SQLStatement "SELECT 1" []])
    , ("emptySQL", sqlDefaultLimits, [SQLStatement "  " []])
    , ("tooManyParameters", sqlDefaultLimits, [SQLStatement "SELECT ?" (replicate 101 SQLNull)])
    , ("oversizedParameter", sqlDefaultLimits{maximumBytes=256}, [SQLStatement "SELECT ?" [SQLBlob (Bytes.replicate 1024 0)]])
    , ("nan", sqlDefaultLimits, [SQLStatement "SELECT ?" [SQLNumber (0/0)]])
    , ("infinity", sqlDefaultLimits, [SQLStatement "SELECT ?" [SQLNumber (1/0)]])
    ]
  recovery <- sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT COUNT(*) FROM checks" [])
  pure (object ["inputChecks" .= inputChecks, "recovery" .= rows recovery, "typed" .= rows typed, "columns" .= columns typed, "rollback" .= isError rolledBack, "count" .= rows count, "afterLimit" .= rows afterLimit, "rowLimit" .= isError limit, "byteLimit" .= isError byteLimit])
  where isError (Left _) = True; isError _ = False

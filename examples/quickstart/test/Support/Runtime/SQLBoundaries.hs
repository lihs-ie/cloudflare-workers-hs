module Support.Runtime.SQLBoundaries (sqlProbe) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectStorage(..))
import Cloudflare.Workers.Binding.DurableObject.SQL
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, try)
import Data.Aeson (eitherDecodeStrict')
import Data.Text qualified as Text
import Data.ByteString qualified as Bytes
import GHC.Wasm.Prim (JSVal)

sqlProbe :: JSVal -> JSVal -> IO JSVal
sqlProbe handle commandValue = do
    command <- jsValToText commandValue
    result <- try @SomeException $ case command of
        "json-unknown" -> pure (Text.pack (show (eitherDecodeStrict' "{\"tag\":\"unknown\"}" :: Either String SQLValue)))
        "blob-input" -> Text.pack . show <$> sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT ?" [SQLBlob (Bytes.pack [0,255])])
        "statement-limit" -> run sqlDefaultLimits{maximumStatements=1} [statement,statement]
        "empty-sql" -> run sqlDefaultLimits [SQLStatement "  " []]
        "long-sql" -> run sqlDefaultLimits [SQLStatement (Text.replicate 65537 "x") []]
        "parameter-count" -> run sqlDefaultLimits [SQLStatement "SELECT ?" (replicate 101 SQLNull)]
        "nan" -> run sqlDefaultLimits [SQLStatement "SELECT ?" [SQLNumber (0/0)]]
        "infinite" -> run sqlDefaultLimits [SQLStatement "SELECT ?" [SQLNumber (1/0)]]
        "unsafe-integer" -> run sqlDefaultLimits [SQLStatement "SELECT ?" [SQLNumber 9007199254740992]]
        "input-bytes" -> run sqlDefaultLimits{maximumBytes=128} [SQLStatement "SELECT ?" [SQLText (Text.replicate 100 "x")]]
        "rows-negative" -> run sqlDefaultLimits{maximumRows = -1} [statement]
        "rows-upper" -> run sqlDefaultLimits{maximumRows = 10001} [statement]
        "bytes-zero" -> run sqlDefaultLimits{maximumBytes = 0} [statement]
        "bytes-upper" -> run sqlDefaultLimits{maximumBytes = 16777217} [statement]
        "statements-zero" -> run sqlDefaultLimits{maximumStatements = 0} [statement]
        "statements-upper" -> run sqlDefaultLimits{maximumStatements = 129} [statement]
        "output-rows" -> run sqlDefaultLimits{maximumRows=0} [statement]
        "output-bytes" -> run sqlDefaultLimits{maximumBytes=128} [SQLStatement "SELECT 1" []]
        "execute" -> Text.pack . show <$> sqlExecute storage sqlDefaultLimits statement
        _ -> run sqlDefaultLimits [statement]
    textToJSVal (either (Text.pack . displayException) id result)
  where
    storage = DurableObjectStorage handle
    statement = SQLStatement "SELECT ?" [SQLNumber 1.5, SQLText "text", SQLNull]
    run limits statements = Text.pack . show <$> sqlBatch storage limits statements

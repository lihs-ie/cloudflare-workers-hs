module Support.Runtime.StorageErrors (storageErrorProbe) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectStorage(..))
import Cloudflare.Workers.Binding.DurableObject.SQL
import Data.Aeson (eitherDecode)
import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query
import Cloudflare.Workers.Internal.FFI.KV qualified as KVFFI
import Cloudflare.Workers.Binding.KV
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Applicative (liftA2)
import Control.Monad (unless)
import Control.Exception (SomeException, displayException, evaluate, try)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

-- Observe public results inside the exception boundary, including lazy metadata.
storageErrorProbe :: JSVal -> JSVal -> IO JSVal
storageErrorProbe handle commandValue = do
    command <- jsValToText commandValue
    outcome <- try @SomeException $ do
        result <- case command of
            "sql-empty-limit" -> shown <$> sqlBatch (DurableObjectStorage handle) (SQLLimits 0 1 1) []
            "sql-value-shape" -> pure (shown (eitherDecode "[]" :: Either String SQLValue))
            "sql-result-shape" -> pure (shown (eitherDecode "[]" :: Either String SQLResult))
            "d1-selectors" -> do
                let statement = D1Statement "SELECT ? AS value" [D1Real 1.25]
                prepared <- d1Prepare (D1 handle) (d1StatementSQL statement)
                bound <- d1Bind prepared (d1StatementParameters statement)
                shown <$> d1First bound
            "d1-composition" -> do
                let a = d1Column "a" d1Integer
                    b = d1Column "b" d1Integer
                    good = [("a",D1Integer 2),("b",D1Integer 3)]
                    bad = [("a",D1Text "wrong"),("b",D1Integer 3)]
                    check condition = unless condition (fail "D1 composition contract failed")
                check (decodeD1Row (liftA2 (+) a b) good == Right 5)
                check (decodeD1Row (a *> b) good == Right 3)
                check (decodeD1Row (a <* b) good == Right 2)
                check (decodeD1Row (a >> b) good == Right 3)
                check (decodeD1Row (return (7 :: Integer)) [] == Right 7)
                check (decodeD1Row (9 <$ a) good == Right (9 :: Integer))
                check (decodeD1Row (d1Column "a" (9 <$ d1Integer)) good == Right (9 :: Integer))
                let rejected = Left (D1ColumnTypeMismatch "a" D1IntegerType D1TextType)
                check (decodeD1Row (a *> b) bad == rejected)
                check (decodeD1Row (a <* b) bad == rejected)
                check (decodeD1Row (a >> b) bad == rejected)
                check (decodeD1Row (9 <$ a) bad == rejected)
                check (decodeD1Row (d1Column "a" (9 <$ d1Integer)) bad == rejected)
                check (decodeD1Row (liftA2 (+) a b) bad == rejected)
                caught <- try @D1DecodeError (decodeD1RowOrThrow a bad)
                case caught of
                    Left failure -> pure (Text.pack (displayException failure))
                    Right _ -> fail "Expected typed decoder exception"
            "kv-cache-status" -> maybe "missing" id . kvListResultCacheStatus <$> kvList (KV handle) Nothing Nothing Nothing
            "d1-prepare" -> d1Prepare (D1 handle) "SELECT 1.25 AS value" >>= fmap shown . d1First
            "d1-all" -> shown <$> d1All (D1PreparedStatement handle)
            "d1-first" -> shown <$> d1First (D1PreparedStatement handle)
            "d1-run" -> shown <$> d1Run (D1PreparedStatement handle)
            "d1-batch" -> shown <$> d1Batch (D1 handle) [D1PreparedStatement handle]
            "d1-exec" -> shown <$> d1Exec (D1 handle) "SELECT 1"
            "d1-real" -> d1Bind (D1PreparedStatement handle) [D1Real 1.25] >>= fmap shown . d1First
            "d1-unsafe-low" -> d1Bind (D1PreparedStatement handle) [D1Integer (-9007199254740992)] >> pure "unexpected"
            "d1-unsafe-high" -> d1Bind (D1PreparedStatement handle) [D1Integer 9007199254740992] >> pure "unexpected"
            "d1-validate" -> case validateD1Statement (D1Statement "SELECT ?" [D1Text "text", D1Null, D1Blob "bytes"]) of
                Left failure -> fail (show failure)
                Right _ -> pure "ok"
            "kv-ffi-json" -> do
                result <- KVFFI.kvPutViaFFI handle "key" (KVFFI.KVJSONValueViaFFI "{\"version\":2}") Nothing Nothing Nothing
                either (fail . Text.unpack) (const (pure "ok")) result
            "kv-default-ttl" -> pure (shown (kvCacheTtlIsValid kvReadDefaultOptions))
            "kv-get" -> maybe "missing" valueText <$> kvGet (KV handle) "key" KVReadText options
            "kv-metadata" -> metadataText <$> kvGetWithMetadata (KV handle) "key" KVReadText options
            "kv-many" -> shown . fmap (fmap (fmap valueText)) . kvBulkResultValues <$> kvGetMany (KV handle) batch KVBulkReadText options
            "kv-many-metadata" -> shown . fmap (fmap metadataText) . kvBulkMetadataResultValues <$> kvGetManyWithMetadata (KV handle) batch KVBulkReadText options
            "kv-put" -> kvPut (KV handle) "key" (KVPutText "value") kvPutDefaultOptions >> pure "ok"
            "kv-delete" -> kvDelete (KV handle) "key" >> pure "ok"
            "kv-list" -> shown <$> kvList (KV handle) Nothing Nothing Nothing
            _ -> fail "unknown storage error command"
        _ <- evaluate (Text.length result)
        pure result
    textToJSVal (either (Text.pack . displayException) id outcome)
  where
    options = KVReadOptions (Just 30)
    batch = KVKeyBatch "key" ["missing"]
    shown :: Show a => a -> Text.Text
    shown = Text.pack . show
    valueText (KVTextValue value) = value
    valueText (KVJSONValue value) = value
    valueText (KVArrayBufferValue value) = shown value
    valueText (KVStreamValue _) = "stream"
    metadataText value = shown (fmap valueText (kvMetadataResultValue value), kvMetadataResultMetadata value, kvMetadataResultCacheStatus value)

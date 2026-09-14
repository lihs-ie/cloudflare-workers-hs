module Support.JobsFailures (jobsFailure) where

import Cloudflare.Workers.Binding.DurableObject
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Control.Exception (SomeException, fromException, throwIO, try)
import Data.Aeson
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import GHC.Wasm.Prim (JSVal)
import LibraryExamples.Jobs

-- Inject only the native boundary; application decoding and error handling run unchanged.
jobsFailure :: JSVal -> JSVal -> JSVal -> IO JSVal
jobsFailure modeRaw input rawInput = do
  mode <- jsValToText modeRaw
  raw <- jsValToText rawInput
  let namespace = DurableObjectNamespace input
      storage = DurableObjectStorage input
      value = either (const (throwIO JobInput)) pure (eitherDecodeStrict' (encodeUtf8 raw))
  outcome <- try @SomeException $ case mode of
    "process" -> value >>= processJob namespace >> pure Null
    "read" -> readJobState namespace raw
    "update" -> value >>= updateJobSettings namespace
    "history-rpc" -> readSettingsHistory namespace
    "commit" -> toJSON <$> commitJob storage raw
    "state" -> toJSON <$> jobState storage raw
    "save" -> toJSON <$> saveSettings storage raw
    "history" -> toJSON <$> settingsHistory storage
    _ -> throwIO JobInput
  textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ case outcome of
    Right result -> object ["ok" .= True, "value" .= result]
    Left exception -> object ["ok" .= False, "error" .= classify exception]
  where
    classify exception = case fromException exception :: Maybe JobsError of
      Just failure -> show failure
      Nothing -> case fromException exception :: Maybe DurableObjectError of
        Just (DurableObjectRPCFailed _) -> "DurableObjectRPCFailed"
        Just (DurableObjectStorageFailed _) -> "DurableObjectStorageFailed"
        _ -> "OtherException"

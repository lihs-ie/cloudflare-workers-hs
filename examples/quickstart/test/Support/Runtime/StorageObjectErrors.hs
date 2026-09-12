module Support.Runtime.StorageObjectErrors (storageObjectErrors) where

import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Streaming (ReadableStreamReadError (..))
import Cloudflare.Workers.URL (parseURL)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, evaluate, try)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

-- Observe public results inside the exception boundary, including lazy payloads.
storageObjectErrors :: JSVal -> JSVal -> IO JSVal
storageObjectErrors handle rawCommand = do
    command <- jsValToText rawCommand
    result <- try @SomeException $ do
        output <- case command of
            "name" -> doIDFromName (DurableObjectNamespace handle) "named-object" >>= doIDToString
            "restore" -> do
                restored <- doIDFromString (DurableObjectNamespace handle) "stored-identifier"
                either (pure . Text.pack . show) doIDToString restored
            "rpc" -> do
                arg <- textToJSVal "argument"
                outcome <- doCall (DurableObjectStub handle) "echo" [DurableObjectValue arg]
                either (pure . Text.pack . show) (\(DurableObjectValue value) -> jsValToText value) outcome
            "get" -> Text.pack . show <$> doStorageGet storage "key"
            "put" -> doStoragePut storage "key" "abc" >>= shown
            "delete" -> doStorageDelete storage "key" >>= shown
            "list" -> doStorageList storage (Just "prefix") True (Just 2) >>= shown
            "transaction" -> doStorageTransaction storage [DurableObjectStorageOperationDelete "key"] >>= shown
            "set-alarm" -> doStorageSetAlarm storage 123 >>= shown
            "delete-alarm" -> doStorageDeleteAlarm storage >>= shown
            "head" -> r2Head (R2Bucket handle) "key" >>= shown
            "fetch-query" -> request Nothing >>= doFetch (DurableObjectStub handle) >>= shown . responseStatus
            "fetch-exceeded" -> request (Just (const (pure (Left ReadableStreamExceededByteLimit)))) >>= doFetch (DurableObjectStub handle) >>= shown . responseStatus
            "fetch-stalled" -> request (Just (const (pure (Left ReadableStreamStalled)))) >>= doFetch (DurableObjectStub handle) >>= shown . responseStatus
            _ -> fail "unknown storage object command"
        _ <- evaluate (Text.length output)
        pure output
    textToJSVal (either (Text.pack . displayException) id result)
  where
    storage = DurableObjectStorage handle
    shown value = pure (Text.pack (show value))
    request reader = case parseURL "/object?key=value" of
        Nothing -> fail "invalid fixture URL"
        Just url -> pure (Request POST url Nothing (headersFromList []) reader Nothing)

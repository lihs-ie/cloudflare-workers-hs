-- | Contract example for the library's custom ctx.cache.purge capability.
-- Standard Cloudflare ExecutionContext does not supply this capability.
module LibraryExamples.CachePurge (runCachePurge) where

import Cloudflare.Workers.Cache
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Cloudflare.Workers.Reactor (WorkersExecutionContext(..))
import Control.Exception (try)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)

-- | Choose one purge operation and preserve the structured provider outcome.
-- The caller supplies the explicit custom capability; no native support is assumed.
runCachePurge :: JSVal -> JSVal -> IO JSVal
runCachePurge contextValue modeValue = do
  mode <- jsValToText modeValue
  let options = case mode of
        "tags" -> Just (PurgeTags ["guide", "catalog"])
        "prefixes" -> Just (PurgePathPrefixes ["/guide/", "/catalog/"])
        "everything" -> Just PurgeEverything
        _ -> Nothing
  value <- case options of
    Nothing -> pure (object ["outcome" .= ("invalid-operation" :: String)])
    Just selected -> do
      result <- try @CachePurgeFailed (cachePurge (WorkersExecutionContext contextValue) selected)
      pure $ case result of
        Left _ -> object ["outcome" .= ("capability-failed" :: String)]
        Right response -> object
          [ "outcome" .= ("resolved" :: String)
          , "success" .= cachePurgeResultSuccess response
          , "errors" .= fmap errorValue (cachePurgeResultErrors response)
          ]
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode value)))
  where
    errorValue :: CachePurgeError -> Value
    errorValue failure = object
      [ "code" .= cachePurgeErrorCode failure
      , "message" .= cachePurgeErrorMessage failure
      ]

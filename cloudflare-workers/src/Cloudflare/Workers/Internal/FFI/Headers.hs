module Cloudflare.Workers.Internal.FFI.Headers (
  headersFromJSVal,
  headersToJSVal 
) where

import GHC.Wasm.Prim (JSVal)
import Cloudflare.Workers.Headers (Headers, headersFromList, headerAppend, headersToList)
import Control.Monad (foldM, forM_)
import Control.Exception (throwIO)
import Data.Text qualified as Text
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)

headersFromJSVal :: JSVal -> IO Headers
headersFromJSVal headersJSValue = do
  flattenedEntriesJSValue <- jsFlattenHeaderEntries headersJSValue >>= decodeHeaderEnvelope 
  entryCount <- jsArrayLength flattenedEntriesJSValue 
  foldM (accumulateHeaderPair flattenedEntriesJSValue ) (headersFromList []) [0, 2 .. entryCount -1]
  where
    accumulateHeaderPair flattenedEntriesJSValue accumulatedHeaders nameIndex = do
      nameJSValue <- jsArrayIndex flattenedEntriesJSValue nameIndex 
      valueJSValue <- jsArrayIndex flattenedEntriesJSValue  (nameIndex  + 1)
      name <- jsValToText nameJSValue 
      value <- jsValToText valueJSValue 
      pure (headerAppend name value accumulatedHeaders )

headersToJSVal :: Headers -> IO JSVal
headersToJSVal headers = do
  headersJSValue <- jsNewHeaders 
  forM_ (headersToList headers) $ \(name, value) -> do
    nameJSValue <- textToJSVal name
    valueJSValue <- textToJSVal value
    appended <- jsHeadersAppend headersJSValue nameJSValue valueJSValue >>= decodeHeaderEnvelope
    -- Observe the trusted completion value so IO () cannot discard a lazy FFI result.
    completed <- jsAppendCompleted appended
    if completed then pure () else throwIO (userError "Header append did not complete") 
  pure headersJSValue 

foreign import javascript unsafe "new Headers()"
    jsNewHeaders :: IO JSVal

decodeHeaderEnvelope :: JSVal -> IO JSVal
decodeHeaderEnvelope envelope = do
  outcome <- decodeEnveloped pure envelope
  either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
  """
  (() => {
    try {
      $1.append($2, $3);
      return { ok: true, value: true };
    } catch (_) {
      return { ok: false, message: "Failed to append a native Header" };
    }
  })()
  """
  jsHeadersAppend :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1 === true"
  jsAppendCompleted :: JSVal -> IO Bool

foreign import javascript unsafe
  """
  (() => {
    const sourceArray = $1;
    if (!Array.isArray(sourceArray)) {
      throw new TypeError('the flattened Headers entry array is not a JS Array: ' + typeof sourceArray);
    }
    const elementCount = sourceArray.length;
    if (!Number.isSafeInteger(elementCount) || elementCount < 0 || elementCount > 2147483647) {
      throw new RangeError('the flattened Headers entry array has a length no 32-bit Haskell Int can carry');
    }
    return elementCount;
  })()
  """
  jsArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsArrayIndex :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe 
  """
  (() => {
    try {
    const result = [];
    for (const [name, value] of $1.entries()) {
      if (typeof name !== "string" || typeof value !== "string") {
        throw new TypeError("Header entries must contain strings");
      }
      if (name.toLowerCase() !== 'set-cookie') {
        result.push(name);
        result.push(value);
      }
    }

    for (const cookie of $1.getSetCookie()) {
      if (typeof cookie !== "string") {
        throw new TypeError("Set-Cookie values must be strings");
      }
      result.push('set-cookie');
      result.push(cookie);
    }

    return { ok: true, value: result };
    } catch (_) {
      return { ok: false, message: "Failed to decode native Headers entries" };
    }
  })()
  """
  jsFlattenHeaderEntries :: JSVal -> IO JSVal

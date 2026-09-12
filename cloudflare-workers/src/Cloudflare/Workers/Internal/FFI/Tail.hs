module Cloudflare.Workers.Internal.FFI.Tail (
    tailEventJSValuesViaFFI,
    tailEventScriptNameViaFFI,
    tailEventOutcomeViaFFI,
    tailEventEventTimestampMillisViaFFI,
) where

import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

tailEventJSValuesViaFFI :: JSVal -> IO [JSVal]
tailEventJSValuesViaFFI eventsJSVal = do
    eventCount <- jsArrayLength eventsJSVal
    traverse (jsArrayIndex eventsJSVal) [0 .. eventCount - 1]

tailEventScriptNameViaFFI :: JSVal -> IO (Maybe Text)
tailEventScriptNameViaFFI eventItemJSVal = do
    fieldJSVal <- jsTailEventScriptNameField eventItemJSVal
    isNullish <- jsIsNullish fieldJSVal
    if isNullish then pure Nothing else Just <$> jsValToText fieldJSVal

tailEventOutcomeViaFFI :: JSVal -> IO Text
tailEventOutcomeViaFFI eventItemJSVal = jsValToText =<< jsTailEventOutcomeField eventItemJSVal

tailEventEventTimestampMillisViaFFI :: JSVal -> IO (Maybe Integer)
tailEventEventTimestampMillisViaFFI itemJSVal = do
    fieldJSVal <- jsTailEventEventTimestampField itemJSVal
    isNullish <- jsIsNullish fieldJSVal
    if isNullish then pure Nothing else Just . round <$> jsDoubleFromJSVal fieldJSVal

foreign import javascript unsafe
    """
    (() => {
      const sourceArray = $1;

      if (!Array.isArray(sourceArray)) {
        throw new TypeError('the Tail event array is not a JS Array: ' + typeof sourceArray);
      }

      const elementCount = sourceArray.length;

      if (!Number.isSafeInteger(elementCount) || elementCount < 0 || elementCount > 2147483647) {
        throw new RangeError('the Tail event array has a length no 32-bit Haskell Int can carry');
      }

      return elementCount;
    })()
    """
    jsArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsArrayIndex :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "$1.scriptName"
    jsTailEventScriptNameField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.outcome"
    jsTailEventOutcomeField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.eventTimestamp"
    jsTailEventEventTimestampField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1 === undefined || $1 === null"
    jsIsNullish :: JSVal -> IO Bool

foreign import javascript unsafe
    """
    (() => {
      const numberValue = $1;

      if (!Number.isFinite(numberValue)) {
        throw new TypeError('the tail event number field is not a finite number: ' + typeof numberValue);
      }

      return numberValue;
    })()
    """
    jsDoubleFromJSVal :: JSVal -> IO Double

module Cloudflare.Workers.Internal.FFI.Cache (
    CacheKeyViaFFI (..),
    cacheStorageViaFFI,
    cacheAPIDefaultViaFFI,
    cacheAPIOpenViaFFI,
    cacheAPIPutViaFFI,
    cacheAPIMatchViaFFI,
    cacheAPIDeleteViaFFI,
    cachePurgeViaFFI,
) where

import Control.Exception (SomeException, displayException, try, throwIO)
import Control.Monad (forM, join, when)
import Data.Foldable (for_)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.HTTP (
    Request,
    Response,
    ResponseBody (ResponseBodyBytes, ResponseBodyStream),
    Status (Status),
    createResponse,
    methodToText,
    requestHeaders,
    requestMethod,
    requestURL,
 )
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Headers (headersFromJSVal, headersToJSVal)
import Cloudflare.Workers.Internal.FFI.Response (responsetoJSVal)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Streaming (readableStreamFromJSVal)
import Cloudflare.Workers.URL (urlText)

data CacheKeyViaFFI
    = CacheRequestKeyViaFFI Request
    | CacheURLKeyViaFFI Text

cacheStorageViaFFI :: IO JSVal
cacheStorageViaFFI = jsCaches

cacheAPIDefaultViaFFI :: JSVal -> IO JSVal
cacheAPIDefaultViaFFI = jsCacheDefault

cacheAPIOpenViaFFI :: JSVal -> Text -> IO (Either Text JSVal)
cacheAPIOpenViaFFI storageJSVal name = do
    nameJSVal <- textToJSVal name
    decodeEnveloped pure =<< jsCacheOpenEnveloped storageJSVal nameJSVal

cacheAPIPutViaFFI :: JSVal -> CacheKeyViaFFI -> Response -> IO (Either Text ())
cacheAPIPutViaFFI cacheJSVal key response = do
    keyJSVal <- cacheKeyToJSVal key
    responseJSVal <- responsetoJSVal response
    decodeEnveloped (const (pure ())) =<< jsCachePutEnveloped cacheJSVal keyJSVal responseJSVal

cacheAPIMatchViaFFI :: JSVal -> CacheKeyViaFFI -> Bool -> IO (Either Text (Maybe Response))
cacheAPIMatchViaFFI cacheJSVal key ignoreMethod = do
    keyJSVal <- cacheKeyToJSVal key
    envelopeJSVal <- jsCacheMatchEnveloped cacheJSVal keyJSVal ignoreMethod
    decodeEnvelopedSafely decodeMaybeResponse envelopeJSVal

cacheAPIDeleteViaFFI :: JSVal -> CacheKeyViaFFI -> Bool -> IO (Either Text Bool)
cacheAPIDeleteViaFFI cacheJSVal key ignoreMethod = do
    keyJSVal <- cacheKeyToJSVal key
    decodeEnveloped jsBooleanValue =<< jsCacheDeleteEnveloped cacheJSVal keyJSVal ignoreMethod

cacheKeyToJSVal :: CacheKeyViaFFI -> IO JSVal
cacheKeyToJSVal (CacheURLKeyViaFFI url) = textToJSVal url
cacheKeyToJSVal (CacheRequestKeyViaFFI request) = do
    urlJSVal <- textToJSVal (urlText (requestURL request))
    methodJSVal <- textToJSVal (methodToText (requestMethod request))
    headersJSVal <- headersToJSVal (requestHeaders request)
    jsNewCacheRequest urlJSVal methodJSVal headersJSVal

decodeMaybeResponse :: JSVal -> IO (Maybe Response)
decodeMaybeResponse responseJSVal = do
    absent <- jsIsNullish responseJSVal
    if absent then pure Nothing else Just <$> decodeResponse responseJSVal

decodeResponse :: JSVal -> IO Response
decodeResponse responseJSVal = do
    statusCodeValue <- jsCacheResponseStatus responseJSVal
    headers <- headersFromJSVal =<< jsCacheResponseHeaders responseJSVal
    bodyJSVal <- jsCacheResponseBody responseJSVal
    bodyIsNullish <- jsIsNullish bodyJSVal
    let body = if bodyIsNullish then ResponseBodyBytes mempty else ResponseBodyStream (readableStreamFromJSVal bodyJSVal)
    pure (createResponse (Status statusCodeValue) headers body)

decodeEnvelopedSafely :: (JSVal -> IO value) -> JSVal -> IO (Either Text value)
decodeEnvelopedSafely decoder envelopeJSVal = do
    outcome <- try (decodeEnveloped decoder envelopeJSVal)
    pure $ case outcome of
        Left exception -> decodeFailure exception
        Right decoded -> decoded
  where
    decodeFailure :: SomeException -> Either Text value
    decodeFailure = Left . Text.pack . displayException

cachePurgeViaFFI :: JSVal -> Maybe [Text] -> Maybe [Text] -> Bool -> IO (Either Text (Bool, [(Int, Text)]))
cachePurgeViaFFI ctxJSVal maybeTags maybePathPrefixes purgeEverything = do
    optionsJSVal <- jsEmptyObject
    for_ maybeTags $ \tags -> do
        tagsArrayJSVal <- jsTextArray tags
        jsSetPurgeOptionTags optionsJSVal tagsArrayJSVal
    for_ maybePathPrefixes $ \pathPrefixes -> do
        pathPrefixesArrayJSVal <- jsTextArray pathPrefixes
        jsSetPurgeOptionPathPrefixes optionsJSVal pathPrefixesArrayJSVal
    when purgeEverything (jsSetPurgeOptionPurgeEverything optionsJSVal True)
    join <$> (decodeEnvelopedSafely decodePurgeResult =<< jsCachePurgeEnveloped ctxJSVal optionsJSVal)
  where
    decodePurgeResult resultJSVal = do
        hasBooleanSuccess <- jsPurgeResultHasBooleanSuccess resultJSVal
        if hasBooleanSuccess
            then Right <$> readPurgeResult resultJSVal
            else Left . malformedPurgeResultMessage <$> (jsValToText =<< jsDescribePurgeResultShape resultJSVal)
    readPurgeResult resultJSVal = do
        success <- jsPurgeResultSuccessField resultJSVal
        hasErrorsArray <- jsPurgeResultHasErrorsArray resultJSVal
        errors <- if hasErrorsArray then readPurgeErrors resultJSVal else pure []
        pure (success, errors)
    readPurgeErrors resultJSVal = do
        errorsArrayJSVal <- jsPurgeResultErrorsField resultJSVal
        errorCount <- jsArrayLength errorsArrayJSVal
        forM [0 .. errorCount - 1] (readPurgeError errorsArrayJSVal)
    readPurgeError errorsArrayJSVal index = do
        errorJSVal <- jsArrayIndex errorsArrayJSVal index
        code <- jsPurgeErrorCodeField errorJSVal
        message <- jsValToText =<< jsPurgeErrorMessageField errorJSVal
        pure (code, message)

malformedPurgeResultMessage :: Text -> Text
malformedPurgeResultMessage observedShape =
    "ctx.cache.purge resolved without a boolean `success` field -- observed " <> observedShape

jsTextArray :: [Text] -> IO JSVal
jsTextArray values = do
    arrayJSVal <- jsEmptyArray
    for_ values $ \value -> do
        valueJSVal <- textToJSVal value
        jsArrayPush arrayJSVal valueJSVal
    pure arrayJSVal

foreign import javascript unsafe "caches"
    jsCaches :: IO JSVal

foreign import javascript unsafe "$1.default"
    jsCacheDefault :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return { ok: true, value: await $1.open($2) };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    })()
    """
    jsCacheOpenEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.put($2, $3);
        return { ok: true, value: null };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    })()
    """
    jsCachePutEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return { ok: true, value: await $1.match($2, { ignoreMethod: !!$3 }) };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    })()
    """
    jsCacheMatchEnveloped :: JSVal -> JSVal -> Bool -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return { 
          ok: true,
          value: await $1.delete($2, { ignoreMethod: !!$3 }) 
        };
      } catch (error) {
        return {
          ok: false, 
          message: String(error)
        };
      }
    })()
    """
    jsCacheDeleteEnveloped :: JSVal -> JSVal -> Bool -> IO JSVal

foreign import javascript unsafe "new Request($1, { method: $2, headers: $3 })"
    jsNewCacheRequest :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1 === null || $1 === undefined"
    jsIsNullish :: JSVal -> IO Bool

foreign import javascript unsafe "$1 === true"
    jsBooleanValue :: JSVal -> IO Bool

jsCacheResponseStatus :: JSVal -> IO Int
jsCacheResponseStatus input = do
    envelope <- jsCacheResponseStatusEnvelope input
    outcome <- decodeEnveloped jsCacheTrustedInt envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        const status = $1.status;

        if (!Number.isSafeInteger(status) || status < 0 || status > 2147483647) {
        throw new TypeError('Cache match Response status is not a non-negative 32-bit integer');
        }

        return { ok: true, value: status };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsCacheResponseStatus)" };
      }
    })()
    """
    jsCacheResponseStatusEnvelope :: JSVal -> IO JSVal

jsCacheResponseHeaders :: JSVal -> IO JSVal
jsCacheResponseHeaders input = do
    envelope <- jsCacheResponseHeadersEnvelope input
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.headers };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsCacheResponseHeaders)" };
      }
    })()
    """
    jsCacheResponseHeadersEnvelope :: JSVal -> IO JSVal

jsCacheResponseBody :: JSVal -> IO JSVal
jsCacheResponseBody input = do
    envelope <- jsCacheResponseBodyEnvelope input
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.body };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsCacheResponseBody)" };
      }
    })()
    """
    jsCacheResponseBodyEnvelope :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.cache.purge($2)
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsCachePurgeEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "({})"
    jsEmptyObject :: IO JSVal

foreign import javascript unsafe "[]"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push($2)"
    jsArrayPush :: JSVal -> JSVal -> IO ()

jsArrayLength :: JSVal -> IO Int
jsArrayLength input = do
    envelope <- jsArrayLengthEnvelope input
    outcome <- decodeEnveloped jsCacheTrustedInt envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        const sourceArray = $1;
        if (!Array.isArray(sourceArray)) {
        throw new TypeError('the Cache purge result errors field is not a JS Array: ' + typeof sourceArray);
        }
        const elementCount = sourceArray.length;
        if (!Number.isSafeInteger(elementCount) || elementCount < 0 || elementCount > 2147483647) {
        throw new RangeError('the Cache purge result errors field has a length no 32-bit Haskell Int can carry');
        }
        return { ok: true, value: elementCount };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsArrayLength)" };
      }
    })()
    """
    jsArrayLengthEnvelope :: JSVal -> IO JSVal

jsArrayIndex :: JSVal -> Int -> IO JSVal
jsArrayIndex values index = do
    envelope <- jsArrayIndexEnvelope values index
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try { return { ok: true, value: $1[$2] }; }
      catch (_) { return { ok: false, message: "Could not read Cache purge error entry" }; }
    })()
    """
    jsArrayIndexEnvelope :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "$1.tags = $2"
    jsSetPurgeOptionTags :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.pathPrefixes = $2"
    jsSetPurgeOptionPathPrefixes :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.purgeEverything = !!$2"
    jsSetPurgeOptionPurgeEverything :: JSVal -> Bool -> IO ()

jsPurgeResultHasBooleanSuccess :: JSVal -> IO Bool
jsPurgeResultHasBooleanSuccess input = do
    envelope <- jsPurgeResultHasBooleanSuccessEnvelope input
    outcome <- decodeEnveloped jsCacheTrustedBool envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: (typeof $1?.success === 'boolean') };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsPurgeResultHasBooleanSuccess)" };
      }
    })()
    """
    jsPurgeResultHasBooleanSuccessEnvelope :: JSVal -> IO JSVal

jsDescribePurgeResultShape :: JSVal -> IO JSVal
jsDescribePurgeResultShape input = do
    envelope <- jsDescribePurgeResultShapeEnvelope input
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: ('typeof=' + (typeof $1) + ' success=' + (typeof $1?.success) + ' errors=' + (Array.isArray($1?.errors) ? 'array' : typeof $1?.errors)) };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsDescribePurgeResultShape)" };
      }
    })()
    """
    jsDescribePurgeResultShapeEnvelope :: JSVal -> IO JSVal

jsPurgeResultSuccessField :: JSVal -> IO Bool
jsPurgeResultSuccessField input = do
    envelope <- jsPurgeResultSuccessFieldEnvelope input
    outcome <- decodeEnveloped jsCacheTrustedBool envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.success === true };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsPurgeResultSuccessField)" };
      }
    })()
    """
    jsPurgeResultSuccessFieldEnvelope :: JSVal -> IO JSVal

jsPurgeResultHasErrorsArray :: JSVal -> IO Bool
jsPurgeResultHasErrorsArray input = do
    envelope <- jsPurgeResultHasErrorsArrayEnvelope input
    outcome <- decodeEnveloped jsCacheTrustedBool envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: Array.isArray($1?.errors) };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsPurgeResultHasErrorsArray)" };
      }
    })()
    """
    jsPurgeResultHasErrorsArrayEnvelope :: JSVal -> IO JSVal

jsPurgeResultErrorsField :: JSVal -> IO JSVal
jsPurgeResultErrorsField input = do
    envelope <- jsPurgeResultErrorsFieldEnvelope input
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.errors };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsPurgeResultErrorsField)" };
      }
    })()
    """
    jsPurgeResultErrorsFieldEnvelope :: JSVal -> IO JSVal

jsPurgeErrorCodeField :: JSVal -> IO Int
jsPurgeErrorCodeField input = do
    envelope <- jsPurgeErrorCodeFieldEnvelope input
    outcome <- decodeEnveloped jsCacheTrustedInt envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        const errorCode = $1.code;

        if (!Number.isSafeInteger(errorCode) || errorCode < 0 || errorCode > 2147483647) {
        throw new TypeError('the Cache purge error code is not a non-negative 32-bit integer: ' + typeof errorCode);
        }

        return { ok: true, value: errorCode };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsPurgeErrorCodeField)" };
      }
    })()
    """
    jsPurgeErrorCodeFieldEnvelope :: JSVal -> IO JSVal

jsPurgeErrorMessageField :: JSVal -> IO JSVal
jsPurgeErrorMessageField input = do
    envelope <- jsPurgeErrorMessageFieldEnvelope input
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.message };
      } catch (_) {
        return { ok: false, message: "Could not decode native Cache value (jsPurgeErrorMessageField)" };
      }
    })()
    """
    jsPurgeErrorMessageFieldEnvelope :: JSVal -> IO JSVal


-- These decoders see only values validated inside trusted literal envelopes.
foreign import javascript unsafe "$1"
    jsCacheTrustedInt :: JSVal -> IO Int

foreign import javascript unsafe "$1 === true"
    jsCacheTrustedBool :: JSVal -> IO Bool

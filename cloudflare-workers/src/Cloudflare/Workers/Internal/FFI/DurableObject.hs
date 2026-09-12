module Cloudflare.Workers.Internal.FFI.DurableObject (
    doIdFromNameViaFFI,
    doNewUniqueIdViaFFI,
    doNewUniqueIdInJurisdictionViaFFI,
    doIdFromStringViaFFI,
    doIdToStringViaFFI,
    doJurisdictionViaFFI,
    doGetViaFFI,
    doGetByNameViaFFI,
    doFetchViaFFI,
    doCallViaFFI,
    webSocketMessageIsTextViaFFI,
    webSocketMessageTextViaFFI,
    webSocketMessageBytesViaFFI,
    webSocketSendTextViaFFI,
    webSocketSendBytesViaFFI,
    webSocketCloseCodeViaFFI,
    webSocketCloseWasCleanViaFFI,
    doStorageGetViaFFI,
    doStoragePutViaFFI,
    doStorageDeleteViaFFI,
    doStorageListViaFFI,
    doStorageTransactionViaFFI,
    doStorageGetAlarmViaFFI,
    doStorageSetAlarmViaFFI,
    doStorageDeleteAlarmViaFFI,
    doQueueIdempotencyClaimViaFFI,
    doQueueIdempotencyTransitionViaFFI,
    doAlarmRetryCountViaFFI,
    doAlarmIsRetryViaFFI,
    doAlarmScheduledTimeMillisViaFFI,
) where

import Cloudflare.Workers.HTTP (Request (requestHeaders), Response, ResponseBody (ResponseBodyBytes, ResponseBodyWebSocket), PassthroughResponse (PassthroughResponse), Status (Status), createResponse, methodToText, requestBodyReader, requestMethod, requestURL)
import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString, jsByteArrayToByteStringEither)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Headers (headersFromJSVal, headersToJSVal)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Streaming (ReadableStreamReadError (ReadableStreamExceededByteLimit, ReadableStreamStalled))
import Cloudflare.Workers.URL (urlPathRaw, urlQueryRaw)
import Control.Monad (forM, join)
import Data.ByteString (ByteString)
import Data.ByteString qualified as LazyByteString
import Data.Foldable (for_)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

doIdFromNameViaFFI :: JSVal -> Text -> IO JSVal
doIdFromNameViaFFI namespaceJSVal name = do
    nameJSVal <- textToJSVal name
    jsDoIdFromName namespaceJSVal nameJSVal

doNewUniqueIdViaFFI :: JSVal -> IO JSVal
doNewUniqueIdViaFFI = jsDoNewUniqueId

doNewUniqueIdInJurisdictionViaFFI :: JSVal -> Text -> IO (Either Text JSVal)
doNewUniqueIdInJurisdictionViaFFI namespaceJSVal jurisdiction = do
    jurisdictionJSVal <- textToJSVal jurisdiction
    envelopeJSVal <- jsDoNewUniqueIdJurisdictionEnveloped namespaceJSVal jurisdictionJSVal
    decodeEnveloped pure envelopeJSVal

doJurisdictionViaFFI :: JSVal -> Text -> IO (Either Text JSVal)
doJurisdictionViaFFI namespaceJSVal jurisdiction = do
    jurisdictionJSVal <- textToJSVal jurisdiction
    envelopeJSVal <- jsDoJurisdictionEnveloped namespaceJSVal jurisdictionJSVal
    decodeEnveloped pure envelopeJSVal

doIdFromStringViaFFI :: JSVal -> Text -> IO (Either Text JSVal)
doIdFromStringViaFFI namespaceJSVal hexId = do
    hexIdJSVal <- textToJSVal hexId
    envelopeJSVal <- jsDoIdFromStringEnveloped namespaceJSVal hexIdJSVal
    decodeEnveloped pure envelopeJSVal

doIdToStringViaFFI :: JSVal -> IO (Either Text Text)
doIdToStringViaFFI identifier = jsDoIdToStringEnveloped identifier >>= decodeEnveloped jsValToText

doGetViaFFI :: JSVal -> JSVal -> IO JSVal
doGetViaFFI = jsDoGet

doGetByNameViaFFI :: JSVal -> Text -> IO JSVal
doGetByNameViaFFI namespaceJSVal name = do
    nameJSVal <- textToJSVal name
    jsDoGetByName namespaceJSVal nameJSVal

doFetchViaFFI :: JSVal -> Request -> IO (Either Text Response)
doFetchViaFFI stubJSVal request = do
    requestJSVal <- requestToJSVal request
    envelopeJSVal <- jsDoFetchEnveloped stubJSVal requestJSVal
    join <$> decodeEnveloped responseFromEnvelopeValue envelopeJSVal

doCallViaFFI :: JSVal -> Text -> [JSVal] -> IO (Either Text JSVal)
doCallViaFFI stubJSVal methodName args = do
    methodNameJSVal <- textToJSVal methodName
    argsArrayJSVal <- jsEmptyArray
    for_ args (jsArrayPush argsArrayJSVal)
    envelopeJSVal <- jsDoCallEnveloped stubJSVal methodNameJSVal argsArrayJSVal
    decodeEnveloped pure envelopeJSVal

doFetchInternalBaseURL :: Text
doFetchInternalBaseURL = "https://do-internal.invalid"

maxDoFetchRequestBodyBytes :: Int
maxDoFetchRequestBodyBytes = 1024 * 1024
requestToJSVal :: Request -> IO JSVal
requestToJSVal request = do
    urlJSVal <- textToJSVal (doFetchInternalBaseURL <> urlPathRaw url <> queryStringSuffix)
    methodJSVal <- textToJSVal (methodToText (requestMethod request))
    headersJSVal <- headersToJSVal (requestHeaders request)
    bodyJSVal <- case requestBodyReader request of
        Nothing -> jsUndefinedValue
        Just readBody -> do
            drained <- readBody maxDoFetchRequestBodyBytes
            case drained of
                Right lazyBytes -> byteStringToJSByteArray (LazyByteString.toStrict lazyBytes)
                Left ReadableStreamExceededByteLimit ->
                    error "requestToJSVal: request body exceeded the doFetch probe byte limit"
                Left ReadableStreamStalled ->
                    error "requestToJSVal: the request body stream stalled (a chunk carrying no bytes)"
    jsNewRequest urlJSVal methodJSVal headersJSVal bodyJSVal
  where
    url = requestURL request
    queryStringSuffix
        | Text.null queryText = Text.empty
        | otherwise = "?" <> queryText
      where
        queryText = urlQueryRaw url

responseFromEnvelopeValue :: JSVal -> IO (Either Text Response)
responseFromEnvelopeValue responseJSVal = do
    statusCodeValue <- jsResponseStatus responseJSVal
    headersJSVal <- jsResponseHeaders responseJSVal
    headers <- headersFromJSVal headersJSVal
    if statusCodeValue == 101
        then pure (Right (createResponse (Status 101) headers (ResponseBodyWebSocket (PassthroughResponse responseJSVal))))
        else do
            bodyEnvelopeJSVal <- jsResponseBodyBytesEnveloped responseJSVal
            bodyOutcome <- decodeEnveloped jsByteArrayToByteStringEither bodyEnvelopeJSVal
            pure (createResponse (Status statusCodeValue) headers . ResponseBodyBytes <$> join bodyOutcome)

foreign import javascript unsafe "$1.idFromName($2)"
    jsDoIdFromName :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.newUniqueId()"
    jsDoNewUniqueId :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
        return {
          ok: true,
          value: $1.newUniqueId({ jurisdiction: $2 })
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      }
    })()
    """
    jsDoNewUniqueIdJurisdictionEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
        return {
          ok: true,
          value: $1.jurisdiction($2)
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      }
    })()
    """
    jsDoJurisdictionEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
        return {
          ok: true,
          value: $1.idFromString($2)
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      } 
    })()
    """
    jsDoIdFromStringEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
        const value = $1.toString();
        if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
          throw new TypeError("Durable Object identifier must be a 64-digit hexadecimal string");
        }
        return { ok: true, value };
      } catch {
        return { ok: false, message: "Durable Object identifier serialization failed" };
      }
    })()
    """
    jsDoIdToStringEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.get($2)"
    jsDoGet :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.getByName($2)"
    jsDoGetByName :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async() => {
     try {
      return {
        ok: true,
        value: await $1.fetch($2)
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error)
      };
    }
    })()
    """
    jsDoFetchEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1[$2](...$3)
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      }
    })()
    """
    jsDoCallEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "new Request($1, { method: $2, headers: $3, body: $4 })"
    jsNewRequest :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "undefined"
    jsUndefinedValue :: IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const statusCode = $1.status;

      if (!Number.isSafeInteger(statusCode) || statusCode < 0 || statusCode > 2147483647) {
        throw new TypeError('the Durable Object Response status is not a non-negative 32-bit integer: ' + typeof statusCode);
      }

      return statusCode;
    })()
    """
    jsResponseStatus :: JSVal -> IO Int

foreign import javascript unsafe "$1.headers"
    jsResponseHeaders :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: new Uint8Array(await $1.arrayBuffer())
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()
    """
    jsResponseBodyBytesEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "new Uint8Array($1)"
    jsWrapArrayBufferAsUint8Array :: JSVal -> IO JSVal

foreign import javascript unsafe "[]"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push($2)"
    jsArrayPush :: JSVal -> JSVal -> IO ()

webSocketMessageIsTextViaFFI :: JSVal -> IO Bool
webSocketMessageIsTextViaFFI = jsWebSocketMessageIsText

webSocketMessageTextViaFFI :: JSVal -> IO Text
webSocketMessageTextViaFFI = jsValToText

webSocketMessageBytesViaFFI :: JSVal -> IO ByteString
webSocketMessageBytesViaFFI messageJSVal = do
    byteArrayJSVal <- jsWrapArrayBufferAsUint8Array messageJSVal
    jsByteArrayToByteString byteArrayJSVal

webSocketSendTextViaFFI :: JSVal -> Text -> IO (Either Text ())
webSocketSendTextViaFFI webSocketJSVal text = do
    textJSVal <- textToJSVal text
    envelopeJSVal <- jsWebSocketSendEnveloped webSocketJSVal textJSVal
    decodeEnveloped (const (pure ())) envelopeJSVal

webSocketSendBytesViaFFI :: JSVal -> ByteString -> IO (Either Text ())
webSocketSendBytesViaFFI webSocketJSVal bytes = do
    bytesJSVal <- byteStringToJSByteArray bytes
    envelopeJSVal <- jsWebSocketSendEnveloped webSocketJSVal bytesJSVal
    decodeEnveloped (const (pure ())) envelopeJSVal

webSocketCloseCodeViaFFI :: JSVal -> IO Int
webSocketCloseCodeViaFFI = jsWebSocketCloseCode

webSocketCloseWasCleanViaFFI :: JSVal -> IO Bool
webSocketCloseWasCleanViaFFI = jsBoolFromJSVal

foreign import javascript unsafe "typeof $1 === 'string'"
    jsWebSocketMessageIsText :: JSVal -> IO Bool

foreign import javascript unsafe
    """
    (() => {
      try {
        $1.send($2);
        return {
          ok: true,
          value: undefined
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()
    """
    jsWebSocketSendEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const closeCode = $1;

      if (!Number.isSafeInteger(closeCode) || closeCode < 0 || closeCode > 2147483647) {
        throw new TypeError('the WebSocket close code is not a non-negative 32-bit integer: ' + typeof closeCode);
      }

      return closeCode;
    })()
    """
    jsWebSocketCloseCode :: JSVal -> IO Int

foreign import javascript unsafe
    """
    (() => {
      const booleanValue = $1;

      if (booleanValue === true) {
        return true;
      }

      if (booleanValue === false) {
        return false;
      }

      throw new TypeError('the value crossing this boundary is not a boolean: ' + typeof booleanValue);
    })()
    """
    jsBoolFromJSVal :: JSVal -> IO Bool

doStorageGetViaFFI :: JSVal -> Text -> IO (Either Text (Maybe ByteString))
doStorageGetViaFFI storageJSVal key = do
    keyJSVal <- textToJSVal key
    envelopeJSVal <- jsDoStorageGetEnveloped storageJSVal keyJSVal
    join <$> decodeEnveloped decodeStorageValue envelopeJSVal
  where
    decodeStorageValue valueJSVal = do
        isNullish <- jsIsNullishStorageValue valueJSVal
        if isNullish
            then pure (Right Nothing)
            else fmap Just <$> jsByteArrayToByteStringEither valueJSVal

doStoragePutViaFFI :: JSVal -> Text -> ByteString -> IO (Either Text ())
doStoragePutViaFFI storageJSVal key value = do
    keyJSVal <- textToJSVal key
    valueJSVal <- byteStringToJSByteArray value
    envelopeJSVal <- jsDoStoragePutEnveloped storageJSVal keyJSVal valueJSVal
    decodeEnveloped (const (pure ())) envelopeJSVal

doStorageDeleteViaFFI :: JSVal -> Text -> IO (Either Text Bool)
doStorageDeleteViaFFI storageJSVal key = do
    keyJSVal <- textToJSVal key
    envelopeJSVal <- jsDoStorageDeleteEnveloped storageJSVal keyJSVal
    decodeEnveloped jsBoolFromJSVal envelopeJSVal

doStorageListViaFFI :: JSVal -> Maybe Text -> Bool -> Maybe Int -> IO (Either Text [(Text, ByteString)])
doStorageListViaFFI storageJSVal maybePrefix reverseOrder maybeLimit = do
    optionsJSVal <- jsEmptyObjectStorage
    for_ maybePrefix $ \prefix -> do
        prefixJSVal <- textToJSVal prefix
        jsSetStorageListOptionPrefix optionsJSVal prefixJSVal
    jsSetStorageListOptionReverse optionsJSVal reverseOrder
    for_ maybeLimit (jsSetStorageListOptionLimit optionsJSVal)
    envelopeJSVal <- jsDoStorageListEntriesEnveloped storageJSVal optionsJSVal
    join <$> decodeEnveloped decodeEntries envelopeJSVal
  where
    decodeEntries :: JSVal -> IO (Either Text [(Text, ByteString)])
    decodeEntries entriesArrayJSVal = do
        entryCount <- jsStorageArrayLength entriesArrayJSVal
        fmap sequence . forM [0 .. entryCount - 1] $ \index -> do
            pairJSVal <- jsStorageArrayIndex entriesArrayJSVal index
            keyJSVal <- jsStorageArrayIndex pairJSVal 0
            valueJSVal <- jsStorageArrayIndex pairJSVal 1
            key <- jsValToText keyJSVal
            valueOutcome <- jsByteArrayToByteStringEither valueJSVal
            pure
                ( case valueOutcome of
                    Left failureMessage -> Left failureMessage
                    Right value -> Right (key, value)
                )

doStorageTransactionViaFFI :: JSVal -> [(Text, Maybe Text, Maybe ByteString)] -> IO (Either Text ())
doStorageTransactionViaFFI storageJSVal operations = do
    operationsArrayJSVal <- jsEmptyArray
    for_ operations $ \(tag, maybeKey, maybeValue) -> do
        operationJSVal <- jsEmptyObjectStorage
        tagJSVal <- textToJSVal tag
        jsSetStorageOperationTag operationJSVal tagJSVal
        for_ maybeKey $ \key -> do
            keyJSVal <- textToJSVal key
            jsSetStorageOperationKey operationJSVal keyJSVal
        for_ maybeValue $ \value -> do
            valueJSVal <- byteStringToJSByteArray value
            jsSetStorageOperationValue operationJSVal valueJSVal
        jsArrayPush operationsArrayJSVal operationJSVal
    envelopeJSVal <- jsDoStorageTransactionEnveloped storageJSVal operationsArrayJSVal
    decodeEnveloped (const (pure ())) envelopeJSVal

doStorageGetAlarmViaFFI :: JSVal -> IO (Either Text (Maybe Integer))
doStorageGetAlarmViaFFI storageJSVal = do
    envelopeJSVal <- jsDoStorageGetAlarmEnveloped storageJSVal
    decodeEnveloped decodeAlarmTime envelopeJSVal
  where
    decodeAlarmTime :: JSVal -> IO (Maybe Integer)
    decodeAlarmTime alarmTimeJSVal = do
        isNullish <- jsIsNullishStorageValue alarmTimeJSVal
        if isNullish
            then pure Nothing
            else Just . round <$> jsAlarmTimeMillis alarmTimeJSVal

doStorageSetAlarmViaFFI :: JSVal -> Integer -> IO (Either Text ())
doStorageSetAlarmViaFFI storageJSVal scheduledTimeMillis
    | scheduledTimeMillis < 0 = pure (Left "the Durable Object alarm time must not be negative")
    | scheduledTimeMillis > maxSafeJavaScriptInteger = pure (Left "the Durable Object alarm time exceeds JavaScript safe integer range")
    | otherwise = do
        envelopeJSVal <- jsDoStorageSetAlarmEnveloped storageJSVal (fromInteger scheduledTimeMillis)
        decodeEnveloped (const (pure ())) envelopeJSVal

doStorageDeleteAlarmViaFFI :: JSVal -> IO (Either Text ())
doStorageDeleteAlarmViaFFI storageJSVal = do
    envelopeJSVal <- jsDoStorageDeleteAlarmEnveloped storageJSVal
    decodeEnveloped (const (pure ())) envelopeJSVal

doQueueIdempotencyClaimViaFFI ::
    JSVal ->
    Text ->
    Text ->
    Integer ->
    Integer ->
    IO (Either Text (Text, Text, Text, Maybe Integer))
doQueueIdempotencyClaimViaFFI storageJSVal operationIdentifier claimIdentifier observedAt leaseExpiresAt = do
    operationJSVal <- textToJSVal operationIdentifier
    claimJSVal <- textToJSVal claimIdentifier
    envelopeJSVal <-
        jsDoQueueIdempotencyClaimEnveloped
            storageJSVal
            operationJSVal
            claimJSVal
            (fromInteger observedAt)
            (fromInteger leaseExpiresAt)
    decodeEnveloped decodeQueueIdempotencyResult =<< jsValidateQueueIdempotencyResultEnveloped envelopeJSVal

doQueueIdempotencyTransitionViaFFI ::
    JSVal -> Text -> Text -> Integer -> Text -> IO (Either Text (Text, Text, Text, Maybe Integer))
doQueueIdempotencyTransitionViaFFI storageJSVal operationIdentifier claimIdentifier observedAt terminal = do
    operationJSVal <- textToJSVal operationIdentifier
    claimJSVal <- textToJSVal claimIdentifier
    terminalJSVal <- textToJSVal terminal
    envelopeJSVal <- jsDoQueueIdempotencyTransitionEnveloped storageJSVal operationJSVal claimJSVal (fromInteger observedAt) terminalJSVal
    decodeEnveloped decodeQueueIdempotencyResult =<< jsValidateQueueIdempotencyResultEnveloped envelopeJSVal

decodeQueueIdempotencyResult :: JSVal -> IO (Text, Text, Text, Maybe Integer)
decodeQueueIdempotencyResult resultJSVal = do
    tag <- jsValToText =<< jsQueueIdempotencyResultTag resultJSVal
    status <- jsValToText =<< jsQueueIdempotencyResultStatus resultJSVal
    claimIdentifier <- jsValToText =<< jsQueueIdempotencyResultClaimIdentifier resultJSVal
    leaseJSVal <- jsQueueIdempotencyResultLease resultJSVal
    leaseIsNullish <- jsIsNullishStorageValue leaseJSVal
    maybeLease <- if leaseIsNullish then pure Nothing else Just . round <$> jsAlarmTimeMillis leaseJSVal
    pure (tag, status, claimIdentifier, maybeLease)

doAlarmRetryCountViaFFI :: JSVal -> IO Int
doAlarmRetryCountViaFFI = jsDoAlarmRetryCount

doAlarmIsRetryViaFFI :: JSVal -> IO Bool
doAlarmIsRetryViaFFI = jsDoAlarmIsRetry

doAlarmScheduledTimeMillisViaFFI :: JSVal -> IO (Maybe Integer)
doAlarmScheduledTimeMillisViaFFI alarmInfoJSVal = do
    scheduledTimeJSVal <- jsDoAlarmScheduledTime alarmInfoJSVal
    isNullish <- jsIsNullishStorageValue scheduledTimeJSVal
    if isNullish
        then pure Nothing
        else Just . round <$> jsAlarmTimeMillis scheduledTimeJSVal

maxSafeJavaScriptInteger :: Integer
maxSafeJavaScriptInteger = 9007199254740991

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.get($2)
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()
    """
    jsDoStorageGetEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.put($2, $3)
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()  """
    jsDoStoragePutEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.delete($2)
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      }
    })()
    """
    jsDoStorageDeleteEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: Array.from((await $1.list($2)).entries())
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      }
    })()
    """
    jsDoStorageListEntriesEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.transaction(async (txn) => {
          for (const op of $2) {
            if (op.tag === 'put') {
              await txn.put(op.key, op.value);
            } else if (op.tag === 'delete') {
              await txn.delete(op.key);
            } else if (op.tag === 'fail') {
              throw new Error('doStorageTransactionViaFFI: intentional failure probe');
            }
          }
        });
        return {
          ok: true,
          value: undefined
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()
    """
    jsDoStorageTransactionEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1 === undefined || $1 === null"
    jsIsNullishStorageValue :: JSVal -> IO Bool

foreign import javascript unsafe "({})"
    jsEmptyObjectStorage :: IO JSVal

foreign import javascript unsafe "$1.prefix = $2"
    jsSetStorageListOptionPrefix :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.reverse = !!$2"
    jsSetStorageListOptionReverse :: JSVal -> Bool -> IO ()

foreign import javascript unsafe "$1.limit = $2"
    jsSetStorageListOptionLimit :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.tag = $2"
    jsSetStorageOperationTag :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.key = $2"
    jsSetStorageOperationKey :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.value = $2"
    jsSetStorageOperationValue :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe
    """
    (() => {
      const sourceArray = $1;

      if (!Array.isArray(sourceArray)) {
        throw new TypeError('the Durable Object storage entry array is not a JS Array: ' + typeof sourceArray);
      }

      const elementCount = sourceArray.length;

      if (!Number.isSafeInteger(elementCount) || elementCount < 0 || elementCount > 2147483647) {
        throw new RangeError('the Durable Object storage entry array has a length no 32-bit Haskell Int can carry');
      }

      return elementCount;
    })()
    """
    jsStorageArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsStorageArrayIndex :: JSVal -> Int -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.getAlarm()
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      } 
    })()
    """
    jsDoStorageGetAlarmEnveloped :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.setAlarm($2);
        return {
          ok: true,
          value: undefined
        };
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      } 
    })()
    """
    jsDoStorageSetAlarmEnveloped :: JSVal -> Double -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.deleteAlarm();
        return {
          ok: true,
          value: undefined
        };  
      } catch (error) {
        return {
          ok: false,
          message: `${error}`
        };
      } 
    })()
    """
    jsDoStorageDeleteAlarmEnveloped :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        const value = await $1.transaction(async (txn) => {
          const key = `queue-idempotency:${$2}`
          const existing = await txn.get(key);

          if (existing === undefined || existing.status === 'failed' || (existing.status === 'pending' && existing.leaseExpiresAtMilliseconds <= $4))  {
            const state = {
              status: 'pending',
              claimIdentifier: $3,
              leaseExpiresAtMilliseconds: $5
            };

            await txn.put(key, state);
            return { tag: 'acquired', ...state };
          }

          if (existing.status === 'completed') {
              return { tag: 'alreadyCompleted', ...existing };
          }

          return { tag: 'inProgress', ...existing };
        });
        return { ok: true, value };
      } catch (error) {
        let message = 'Queue idempotency operation failed with an unprintable error';
        try { message = String(error); } catch (_) {}
        return { ok: false, message };
      } 
    })()
    """
    jsDoQueueIdempotencyClaimEnveloped :: JSVal -> JSVal -> JSVal -> Double -> Double -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        const value = await $1.transaction(async (txn) => {
          const key = `queue-idempotency:${$2}`;
          const existing = await txn.get(key);
          if (existing === undefined) {
            return { tag: 'ownershipLost', status: 'missing', claimIdentifier: '', leaseExpiresAtMilliseconds: null };
          }
          if (existing.status === 'pending' && existing.claimIdentifier === $3 &&
              existing.leaseExpiresAtMilliseconds > $4) {
            const state = { status: $5, claimIdentifier: $3, leaseExpiresAtMilliseconds: null };
            await txn.put(key, state);
            return { tag: 'transitioned', ...state };
          }
          if (existing.status === $5 && existing.claimIdentifier === $3) {
            return { tag: 'alreadyTerminal', ...existing };
          }
          return { tag: 'ownershipLost', ...existing };
        });
        return { ok: true, value };
      } catch (error) {
        let message = 'Queue idempotency operation failed with an unprintable error';
        try { message = String(error); } catch (_) {}
        return { ok: false, message };
      }
    })()
    """
    jsDoQueueIdempotencyTransitionEnveloped :: JSVal -> JSVal -> JSVal -> Double -> JSVal -> IO JSVal

-- Validate before unsafe field readers: a malformed transaction result must
-- become a recoverable envelope failure, not unwind the WASM reactor.
foreign import javascript unsafe
    """
    (() => {
      try {
        if (!$1.ok) {
          return $1;
        }
        const result = $1.value;
        if (result === null || typeof result !== 'object') {
          throw new TypeError('Invalid queue idempotency result: expected object');
        }
        const { tag, status, claimIdentifier, leaseExpiresAtMilliseconds } = result;
        if (typeof tag !== 'string' || typeof status !== 'string' || typeof claimIdentifier !== 'string') {
          throw new TypeError('Invalid queue idempotency result: expected string fields');
        }
        if (leaseExpiresAtMilliseconds != null &&
            (!Number.isSafeInteger(leaseExpiresAtMilliseconds) || leaseExpiresAtMilliseconds < 0)) {
          throw new TypeError('Invalid queue idempotency result: invalid lease timestamp');
        }
        return { ok: true, value: { tag, status, claimIdentifier, leaseExpiresAtMilliseconds } };
      } catch (error) {
        let message = 'Invalid queue idempotency result: unprintable error';
        try { message = String(error); } catch (_) {}
        return { ok: false, message };
      }
    })()
    """
    jsValidateQueueIdempotencyResultEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.tag"
    jsQueueIdempotencyResultTag :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.status"
    jsQueueIdempotencyResultStatus :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.claimIdentifier"
    jsQueueIdempotencyResultClaimIdentifier :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.leaseExpiresAtMilliseconds"
    jsQueueIdempotencyResultLease :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const alarmTime = $1;

      if (!Number.isSafeInteger(alarmTime) || alarmTime < 0) {
        throw new TypeError('the Durable Object alarm time is not a non-negative safe integer: ' + typeof alarmTime);
      }

      return alarmTime;
    })()
    """
    jsAlarmTimeMillis :: JSVal -> IO Double

foreign import javascript unsafe
    """
    (() => {
      const retryCount = $1?.retryCount ?? 0;

      if (!Number.isSafeInteger(retryCount) || retryCount < 0 || retryCount > 2147483647) {
        throw new TypeError('the Durable Object alarm retryCount is not a non-negative 32-bit integer: ' + typeof retryCount);
      }

      return retryCount;
    })()
    """
    jsDoAlarmRetryCount :: JSVal -> IO Int

foreign import javascript unsafe
    """
    (() => {
      const isRetry = $1?.isRetry ?? false;

      if (isRetry !== true && isRetry !== false) {
        throw new TypeError('the Durable Object alarm isRetry field is not a boolean: ' + typeof isRetry);
      }

      return isRetry;
    })()
    """
    jsDoAlarmIsRetry :: JSVal -> IO Bool

foreign import javascript unsafe "$1?.scheduledTime ?? null"
    jsDoAlarmScheduledTime :: JSVal -> IO JSVal

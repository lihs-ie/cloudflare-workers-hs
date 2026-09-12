module Cloudflare.Workers.Internal.FFI.KV (
    KVReadFormViaFFI (..),
    KVBulkReadFormViaFFI (..),
    KVValueViaFFI (..),
    kvGetViaFFI,
    kvGetWithMetadataViaFFI,
    kvGetManyViaFFI,
    kvGetManyWithMetadataViaFFI,
    kvPutViaFFI,
    kvDeleteViaFFI,
    kvListViaFFI,
) where

import Control.Monad (forM, (>=>))
import Data.ByteString (ByteString)
import Data.Foldable (for_)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)

data KVReadFormViaFFI
    = KVReadTextViaFFI
    | KVReadJSONViaFFI
    | KVReadArrayBufferViaFFI
    | KVReadStreamViaFFI
    deriving stock (Show, Eq)

data KVBulkReadFormViaFFI
    = KVBulkReadTextViaFFI
    | KVBulkReadJSONViaFFI
    deriving stock (Show, Eq)

data KVValueViaFFI
    = KVTextValueViaFFI Text
    | KVJSONValueViaFFI Text
    | KVArrayBufferValueViaFFI ByteString
    | KVStreamValueViaFFI JSVal

kvGetViaFFI :: JSVal -> Text -> KVReadFormViaFFI -> Maybe Int -> IO (Either Text (Maybe KVValueViaFFI))
kvGetViaFFI namespaceJSVal key readForm maybeCacheTtl = do
    keyJSVal <- textToJSVal key
    optionsJSVal <- readOptions readForm maybeCacheTtl
    decodeEnveloped (decodeNullableValue readForm) =<< jsKVGetEnveloped namespaceJSVal keyJSVal optionsJSVal

kvGetWithMetadataViaFFI ::
    JSVal -> Text -> KVReadFormViaFFI -> Maybe Int -> IO (Either Text (Maybe KVValueViaFFI, Maybe Text, Maybe Text))
kvGetWithMetadataViaFFI namespaceJSVal key readForm maybeCacheTtl = do
    keyJSVal <- textToJSVal key
    optionsJSVal <- readOptions readForm maybeCacheTtl
    decodeEnveloped (decodeMetadataResult readForm) =<< jsKVGetWithMetadataEnveloped namespaceJSVal keyJSVal optionsJSVal

kvGetManyViaFFI ::
    JSVal -> [Text] -> KVBulkReadFormViaFFI -> Maybe Int -> IO (Either Text [(Text, Maybe KVValueViaFFI)])
kvGetManyViaFFI namespaceJSVal keys readForm maybeCacheTtl = do
    keysJSVal <- textArray keys
    optionsJSVal <- bulkReadOptions readForm maybeCacheTtl
    decodeEnveloped (decodeBulkValues keys readForm) =<< jsKVGetEnveloped namespaceJSVal keysJSVal optionsJSVal

kvGetManyWithMetadataViaFFI ::
    JSVal ->
    [Text] ->
    KVBulkReadFormViaFFI ->
    Maybe Int ->
    IO (Either Text [(Text, (Maybe KVValueViaFFI, Maybe Text, Maybe Text))])
kvGetManyWithMetadataViaFFI namespaceJSVal keys readForm maybeCacheTtl = do
    keysJSVal <- textArray keys
    optionsJSVal <- bulkReadOptions readForm maybeCacheTtl
    decodeEnveloped (decodeBulkMetadataValues keys readForm)
        =<< jsKVGetWithMetadataEnveloped namespaceJSVal keysJSVal optionsJSVal

kvPutViaFFI ::
    JSVal -> Text -> KVValueViaFFI -> Maybe Integer -> Maybe Int -> Maybe Text -> IO (Either Text ())
kvPutViaFFI namespaceJSVal key value maybeExpiration maybeExpirationTtl maybeMetadataJSON = do
    keyJSVal <- textToJSVal key
    valueJSVal <- encodePutValue value
    optionsJSVal <- jsEmptyObject
    for_ maybeExpiration (jsSetPutOptionExpiration optionsJSVal . fromInteger)
    for_ maybeExpirationTtl (jsSetPutOptionExpirationTtl optionsJSVal)
    for_ maybeMetadataJSON $ \metadataJSON -> do
        metadataJSONJSVal <- textToJSVal metadataJSON
        jsSetPutOptionMetadataFromJSON optionsJSVal metadataJSONJSVal
    decodeEnveloped (const (pure ())) =<< jsKVPutEnveloped namespaceJSVal keyJSVal valueJSVal optionsJSVal

kvDeleteViaFFI :: JSVal -> Text -> IO (Either Text ())
kvDeleteViaFFI namespaceJSVal key = do
    keyJSVal <- textToJSVal key
    decodeEnveloped (const (pure ())) =<< jsKVDeleteEnveloped namespaceJSVal keyJSVal

kvListViaFFI ::
    JSVal ->
    Maybe Text ->
    Maybe Text ->
    Maybe Int ->
    IO (Either Text ([(Text, Maybe Integer, Maybe Text)], Bool, Maybe Text, Maybe Text))
kvListViaFFI namespaceJSVal maybePrefix maybeCursor maybeLimit = do
    optionsJSVal <- jsEmptyObject
    for_ maybePrefix (textToJSVal >=> jsSetListOptionPrefix optionsJSVal)
    for_ maybeCursor (textToJSVal >=> jsSetListOptionCursor optionsJSVal)
    for_ maybeLimit (jsSetListOptionLimit optionsJSVal)
    decodeEnveloped decodeListResult =<< jsKVListEnveloped namespaceJSVal optionsJSVal
  where
    decodeListResult resultJSVal = do
        keysArrayJSVal <- jsListResultKeysField resultJSVal
        keyCount <- jsArrayLength keysArrayJSVal
        keys <- forM [0 .. keyCount - 1] (readListKey keysArrayJSVal)
        listComplete <- jsListResultListCompleteField resultJSVal
        cursor <- readOptionalText jsListResultCursorOrNull resultJSVal
        cacheStatus <- readOptionalText jsCacheStatusOrNull resultJSVal
        pure (keys, listComplete, cursor, cacheStatus)

    readListKey keysArrayJSVal index = do
        keyJSVal <- jsArrayIndex keysArrayJSVal index
        name <- jsListKeyNameField keyJSVal >>= jsValToText
        hasExpiration <- jsListKeyHasExpiration keyJSVal
        expiration <- if hasExpiration then Just . round <$> jsListKeyExpirationField keyJSVal else pure Nothing
        metadata <- readOptionalText jsMetadataJSONOrNull keyJSVal
        pure (name, expiration, metadata)

readOptions :: KVReadFormViaFFI -> Maybe Int -> IO JSVal
readOptions readForm maybeCacheTtl = do
    optionsJSVal <- jsEmptyObject
    typeJSVal <- textToJSVal (readFormText readForm)
    jsSetReadOptionType optionsJSVal typeJSVal
    for_ maybeCacheTtl (jsSetReadOptionCacheTtl optionsJSVal)
    pure optionsJSVal

bulkReadOptions :: KVBulkReadFormViaFFI -> Maybe Int -> IO JSVal
bulkReadOptions readForm maybeCacheTtl = do
    optionsJSVal <- jsEmptyObject
    typeJSVal <- textToJSVal (bulkReadFormText readForm)
    jsSetReadOptionType optionsJSVal typeJSVal
    for_ maybeCacheTtl (jsSetReadOptionCacheTtl optionsJSVal)
    pure optionsJSVal

readFormText :: KVReadFormViaFFI -> Text
readFormText KVReadTextViaFFI = "text"
readFormText KVReadJSONViaFFI = "json"
readFormText KVReadArrayBufferViaFFI = "arrayBuffer"
readFormText KVReadStreamViaFFI = "stream"

bulkReadFormText :: KVBulkReadFormViaFFI -> Text
bulkReadFormText KVBulkReadTextViaFFI = "text"
bulkReadFormText KVBulkReadJSONViaFFI = "json"

decodeNullableValue :: KVReadFormViaFFI -> JSVal -> IO (Maybe KVValueViaFFI)
decodeNullableValue readForm valueJSVal = do
    isNull <- jsIsNullish valueJSVal
    if isNull then pure Nothing else Just <$> decodeValue readForm valueJSVal

decodeValue :: KVReadFormViaFFI -> JSVal -> IO KVValueViaFFI
decodeValue KVReadTextViaFFI valueJSVal = KVTextValueViaFFI <$> jsValToText valueJSVal
decodeValue KVReadJSONViaFFI valueJSVal = KVJSONValueViaFFI <$> (jsJSONStringify valueJSVal >>= jsValToText)
decodeValue KVReadArrayBufferViaFFI valueJSVal =
    KVArrayBufferValueViaFFI <$> (jsWrapArrayBufferAsUint8Array valueJSVal >>= jsByteArrayToByteString)
decodeValue KVReadStreamViaFFI valueJSVal = pure (KVStreamValueViaFFI valueJSVal)

decodeMetadataResult :: KVReadFormViaFFI -> JSVal -> IO (Maybe KVValueViaFFI, Maybe Text, Maybe Text)
decodeMetadataResult readForm resultJSVal = do
    valueJSVal <- jsGetWithMetadataValueField resultJSVal
    value <- decodeNullableValue readForm valueJSVal
    metadata <- readOptionalText jsMetadataJSONOrNull resultJSVal
    cacheStatus <- readOptionalText jsCacheStatusOrNull resultJSVal
    pure (value, metadata, cacheStatus)

decodeBulkValues :: [Text] -> KVBulkReadFormViaFFI -> JSVal -> IO [(Text, Maybe KVValueViaFFI)]
decodeBulkValues keys readForm valuesMapJSVal = forM keys $ \key -> do
    keyJSVal <- textToJSVal key
    valueJSVal <- jsMapGet valuesMapJSVal keyJSVal
    value <- decodeNullableValue (bulkToSingleForm readForm) valueJSVal
    pure (key, value)

decodeBulkMetadataValues ::
    [Text] -> KVBulkReadFormViaFFI -> JSVal -> IO [(Text, (Maybe KVValueViaFFI, Maybe Text, Maybe Text))]
decodeBulkMetadataValues keys readForm valuesMapJSVal = forM keys $ \key -> do
    keyJSVal <- textToJSVal key
    resultJSVal <- jsMapGet valuesMapJSVal keyJSVal
    -- Bulk getWithMetadata represents a missing key as null, rather than
    -- the single-key {value: null, metadata: null} record. Never dereference it.
    missing <- jsIsNullish resultJSVal
    result <- if missing then pure (Nothing, Nothing, Nothing)
              else decodeMetadataResult (bulkToSingleForm readForm) resultJSVal
    pure (key, result)

bulkToSingleForm :: KVBulkReadFormViaFFI -> KVReadFormViaFFI
bulkToSingleForm KVBulkReadTextViaFFI = KVReadTextViaFFI
bulkToSingleForm KVBulkReadJSONViaFFI = KVReadJSONViaFFI

encodePutValue :: KVValueViaFFI -> IO JSVal
encodePutValue (KVTextValueViaFFI value) = textToJSVal value
encodePutValue (KVJSONValueViaFFI value) = textToJSVal value >>= jsJSONParse
encodePutValue (KVArrayBufferValueViaFFI value) = byteStringToJSByteArray value
encodePutValue (KVStreamValueViaFFI value) = pure value

textArray :: [Text] -> IO JSVal
textArray values = do
    arrayJSVal <- jsEmptyArray
    for_ values (textToJSVal >=> jsArrayPush arrayJSVal)
    pure arrayJSVal

readOptionalText :: (JSVal -> IO JSVal) -> JSVal -> IO (Maybe Text)
readOptionalText readField ownerJSVal = do
    fieldJSVal <- readField ownerJSVal
    isNull <- jsIsNullish fieldJSVal
    if isNull then pure Nothing else Just <$> jsValToText fieldJSVal

foreign import javascript safe
    """
    (async () => {
      try { return { ok: true, value: await $1.get($2, $3) }; }
      catch (error) {
        try { return { ok: false, message: String(error) }; }
        catch { return { ok: false, message: 'unstringifiable error' }; }
      }
    })()
    """
    jsKVGetEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try { return { ok: true, value: await $1.getWithMetadata($2, $3) }; }
      catch (error) {
        try { return { ok: false, message: String(error) }; }
        catch { return { ok: false, message: 'unstringifiable error' }; }
      }
    })()
    """
    jsKVGetWithMetadataEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.put($2, $3, $4);
        return { ok: true, value: null };
      } catch (error) {
        try { return { ok: false, message: String(error) }; }
        catch { return { ok: false, message: 'unstringifiable error' }; }
      }
    })()
    """
    jsKVPutEnveloped :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.delete($2);
        return { ok: true, value: null };
      } catch (error) {
        try { return { ok: false, message: String(error) }; }
        catch { return { ok: false, message: 'unstringifiable error' }; }
      }
    })()
    """
    jsKVDeleteEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try { return { ok: true, value: await $1.list($2) }; }
      catch (error) {
        try { return { ok: false, message: String(error) }; }
        catch { return { ok: false, message: 'unstringifiable error' }; }
      }
    })()
    """
    jsKVListEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1 === null || $1 === undefined"
    jsIsNullish :: JSVal -> IO Bool

foreign import javascript unsafe "new Uint8Array($1)"
    jsWrapArrayBufferAsUint8Array :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.value"
    jsGetWithMetadataValueField :: JSVal -> IO JSVal

foreign import javascript unsafe "({})"
    jsEmptyObject :: IO JSVal

foreign import javascript unsafe "([])"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push($2)"
    jsArrayPush :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.get($2)"
    jsMapGet :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "JSON.stringify($1)"
    jsJSONStringify :: JSVal -> IO JSVal

foreign import javascript unsafe "JSON.parse($1)"
    jsJSONParse :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.type = $2"
    jsSetReadOptionType :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.cacheTtl = $2"
    jsSetReadOptionCacheTtl :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.expiration = $2"
    jsSetPutOptionExpiration :: JSVal -> Double -> IO ()

foreign import javascript unsafe "$1.expirationTtl = $2"
    jsSetPutOptionExpirationTtl :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.metadata = JSON.parse($2)"
    jsSetPutOptionMetadataFromJSON :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.prefix = $2"
    jsSetListOptionPrefix :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.cursor = $2"
    jsSetListOptionCursor :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.limit = $2"
    jsSetListOptionLimit :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.keys"
    jsListResultKeysField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const value = $1.list_complete;
      if (value === true) return true;
      if (value === false) return false;
      throw new TypeError('the KV list list_complete field is not a boolean: ' + typeof value);
    })()
    """
    jsListResultListCompleteField :: JSVal -> IO Bool

foreign import javascript unsafe "typeof $1.cursor === 'string' ? $1.cursor : null"
    jsListResultCursorOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.cacheStatus === 'string' ? $1.cacheStatus : null"
    jsCacheStatusOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.metadata === 'undefined' || $1.metadata === null ? null : JSON.stringify($1.metadata)"
    jsMetadataJSONOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const sourceArray = $1;
      if (!Array.isArray(sourceArray)) throw new TypeError('the KV list keys field is not an array');
      const count = sourceArray.length;
      if (!Number.isSafeInteger(count) || count < 0 || count > 2147483647) {
        throw new RangeError('the KV list keys array length cannot fit in a Haskell Int');
      }
      return count;
    })()
    """
    jsArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsArrayIndex :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "$1.name"
    jsListKeyNameField :: JSVal -> IO JSVal

foreign import javascript unsafe "Number.isFinite($1.expiration)"
    jsListKeyHasExpiration :: JSVal -> IO Bool

foreign import javascript unsafe "(() => { const value = $1.expiration; if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid KV expiration'); return value; })()"
    jsListKeyExpirationField :: JSVal -> IO Double

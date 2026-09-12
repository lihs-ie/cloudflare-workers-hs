module Cloudflare.Workers.Binding.KV (
    KV (..),
    KVError (..),
    KVReadType (..),
    KVBulkReadType (..),
    KVReadOptions (..),
    kvReadDefaultOptions,
    kvCacheTtlIsValid,
    KVValue (..),
    KVMetadataResult (..),
    KVKeyBatch (..),
    kvKeyBatchCount,
    kvKeyBatchIsValid,
    KVBulkResult (..),
    KVBulkMetadataResult (..),
    KVPutValue (..),
    KVListKey (..),
    KVListResult (..),
    KVPutOptions (..),
    kvPutDefaultOptions,
    kvGet,
    kvGetWithMetadata,
    kvGetMany,
    kvGetManyWithMetadata,
    kvPut,
    kvDelete,
    kvList,
) where

import Control.Exception (Exception, throwIO)
import Data.ByteString (ByteString)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.KV (
    KVBulkReadFormViaFFI (..),
    KVReadFormViaFFI (..),
    KVValueViaFFI (..),
    kvDeleteViaFFI,
    kvGetManyViaFFI,
    kvGetManyWithMetadataViaFFI,
    kvGetViaFFI,
    kvGetWithMetadataViaFFI,
    kvListViaFFI,
    kvPutViaFFI,
 )
import Cloudflare.Workers.Streaming (ReadableStream, readableStreamFromJSVal, readableStreamToJSVal)

data KVError
    = KVGetFailed Text
    | KVGetWithMetadataFailed Text
    | KVPutFailed Text
    | KVDeleteFailed Text
    | KVListFailed Text
    | KVBulkGetFailed Text
    | KVTooManyKeys Int
    | KVInvalidCacheTtl Int
    deriving stock (Show, Eq)

instance Exception KVError

newtype KV = KV JSVal

data KVReadType
    = KVReadText
    | KVReadJSON
    | KVReadArrayBuffer
    | KVReadStream
    deriving stock (Show, Eq)

data KVBulkReadType
    = KVBulkReadText
    | KVBulkReadJSON
    deriving stock (Show, Eq)

newtype KVReadOptions = KVReadOptions
    { kvReadOptionsCacheTtl :: Maybe Int
    }
    deriving stock (Show, Eq)

kvReadDefaultOptions :: KVReadOptions
kvReadDefaultOptions = KVReadOptions Nothing

kvCacheTtlIsValid :: KVReadOptions -> Bool
kvCacheTtlIsValid (KVReadOptions Nothing) = True
kvCacheTtlIsValid (KVReadOptions (Just seconds)) = seconds >= 30

data KVValue
    = KVTextValue Text
    | KVJSONValue Text
    | KVArrayBufferValue ByteString
    | KVStreamValue ReadableStream

data KVMetadataResult = KVMetadataResult
    { kvMetadataResultValue :: Maybe KVValue
    , kvMetadataResultMetadata :: Maybe Text
    , kvMetadataResultCacheStatus :: Maybe Text
    }

data KVKeyBatch = KVKeyBatch
    { kvKeyBatchFirst :: Text
    , kvKeyBatchRest :: [Text]
    }
    deriving stock (Show, Eq)

kvKeyBatchCount :: KVKeyBatch -> Int
kvKeyBatchCount batch = 1 + length (kvKeyBatchRest batch)

kvKeyBatchIsValid :: KVKeyBatch -> Bool
kvKeyBatchIsValid batch = kvKeyBatchCount batch <= 100

newtype KVBulkResult = KVBulkResult
    { kvBulkResultValues :: [(Text, Maybe KVValue)]
    }

newtype KVBulkMetadataResult = KVBulkMetadataResult
    { kvBulkMetadataResultValues :: [(Text, KVMetadataResult)]
    }

data KVPutValue
    = KVPutText Text
    | KVPutBytes ByteString
    | KVPutStream ReadableStream

data KVListKey = KVListKey
    { kvListKeyName :: Text
    , kvListKeyExpiration :: Maybe Integer
    , kvListKeyMetadata :: Maybe Text
    }
    deriving stock (Show, Eq)

data KVListResult = KVListResult
    { kvListResultKeys :: [KVListKey]
    , kvListResultListComplete :: Bool
    , kvListResultCursor :: Maybe Text
    , kvListResultCacheStatus :: Maybe Text
    }
    deriving stock (Show, Eq)

data KVPutOptions = KVPutOptions
    { kvPutOptionsExpiration :: Maybe Integer
    , kvPutOptionsExpirationTtl :: Maybe Int
    , kvPutOptionsMetadata :: Maybe Text
    }
    deriving stock (Show, Eq)

kvPutDefaultOptions :: KVPutOptions
kvPutDefaultOptions = KVPutOptions Nothing Nothing Nothing

kvGet :: KV -> Text -> KVReadType -> KVReadOptions -> IO (Maybe KVValue)
kvGet (KV namespaceJSVal) key readType options = do
    validateReadOptions options
    outcome <- kvGetViaFFI namespaceJSVal key (toKVReadFormViaFFI readType) (kvReadOptionsCacheTtl options)
    either (throwIO . KVGetFailed) (pure . fmap fromKVValueViaFFI) outcome

kvGetWithMetadata :: KV -> Text -> KVReadType -> KVReadOptions -> IO KVMetadataResult
kvGetWithMetadata (KV namespaceJSVal) key readType options = do
    validateReadOptions options
    outcome <- kvGetWithMetadataViaFFI namespaceJSVal key (toKVReadFormViaFFI readType) (kvReadOptionsCacheTtl options)
    either (throwIO . KVGetWithMetadataFailed) (pure . fromKVMetadataViaFFI) outcome

kvGetMany :: KV -> KVKeyBatch -> KVBulkReadType -> KVReadOptions -> IO KVBulkResult
kvGetMany (KV namespaceJSVal) batch readType options = do
    validateBatch batch
    validateReadOptions options
    outcome <- kvGetManyViaFFI namespaceJSVal (kvKeyBatchValues batch) (toKVBulkReadFormViaFFI readType) (kvReadOptionsCacheTtl options)
    either (throwIO . KVBulkGetFailed) (pure . KVBulkResult . fmap (fmap (fmap fromKVValueViaFFI))) outcome

kvGetManyWithMetadata :: KV -> KVKeyBatch -> KVBulkReadType -> KVReadOptions -> IO KVBulkMetadataResult
kvGetManyWithMetadata (KV namespaceJSVal) batch readType options = do
    validateBatch batch
    validateReadOptions options
    outcome <- kvGetManyWithMetadataViaFFI namespaceJSVal (kvKeyBatchValues batch) (toKVBulkReadFormViaFFI readType) (kvReadOptionsCacheTtl options)
    either (throwIO . KVBulkGetFailed) (pure . KVBulkMetadataResult . fmap (fmap fromKVMetadataViaFFI)) outcome

kvPut :: KV -> Text -> KVPutValue -> KVPutOptions -> IO ()
kvPut (KV namespaceJSVal) key value options = do
    outcome <-
        kvPutViaFFI
            namespaceJSVal
            key
            (toKVPutValueViaFFI value)
            (kvPutOptionsExpiration options)
            (kvPutOptionsExpirationTtl options)
            (kvPutOptionsMetadata options)
    either (throwIO . KVPutFailed) pure outcome

kvDelete :: KV -> Text -> IO ()
kvDelete (KV namespaceJSVal) key = do
    outcome <- kvDeleteViaFFI namespaceJSVal key
    either (throwIO . KVDeleteFailed) pure outcome

kvList :: KV -> Maybe Text -> Maybe Text -> Maybe Int -> IO KVListResult
kvList (KV namespaceJSVal) maybePrefix maybeCursor maybeLimit = do
    outcome <- kvListViaFFI namespaceJSVal maybePrefix maybeCursor maybeLimit
    either (throwIO . KVListFailed) (pure . toKVListResult) outcome
  where
    toKVListResult (rawKeys, listComplete, cursor, cacheStatus) =
        KVListResult
            { kvListResultKeys = fmap toKVListKey rawKeys
            , kvListResultListComplete = listComplete
            , kvListResultCursor = cursor
            , kvListResultCacheStatus = cacheStatus
            }
    toKVListKey (name, expiration, metadata) =
        KVListKey{kvListKeyName = name, kvListKeyExpiration = expiration, kvListKeyMetadata = metadata}

validateReadOptions :: KVReadOptions -> IO ()
validateReadOptions options = case kvReadOptionsCacheTtl options of
    Just seconds | not (kvCacheTtlIsValid options) -> throwIO (KVInvalidCacheTtl seconds)
    _ -> pure ()

validateBatch :: KVKeyBatch -> IO ()
validateBatch batch
    | kvKeyBatchIsValid batch = pure ()
    | otherwise = throwIO (KVTooManyKeys (kvKeyBatchCount batch))

kvKeyBatchValues :: KVKeyBatch -> [Text]
kvKeyBatchValues batch = kvKeyBatchFirst batch : kvKeyBatchRest batch

toKVReadFormViaFFI :: KVReadType -> KVReadFormViaFFI
toKVReadFormViaFFI KVReadText = KVReadTextViaFFI
toKVReadFormViaFFI KVReadJSON = KVReadJSONViaFFI
toKVReadFormViaFFI KVReadArrayBuffer = KVReadArrayBufferViaFFI
toKVReadFormViaFFI KVReadStream = KVReadStreamViaFFI

toKVBulkReadFormViaFFI :: KVBulkReadType -> KVBulkReadFormViaFFI
toKVBulkReadFormViaFFI KVBulkReadText = KVBulkReadTextViaFFI
toKVBulkReadFormViaFFI KVBulkReadJSON = KVBulkReadJSONViaFFI

fromKVValueViaFFI :: KVValueViaFFI -> KVValue
fromKVValueViaFFI (KVTextValueViaFFI value) = KVTextValue value
fromKVValueViaFFI (KVJSONValueViaFFI value) = KVJSONValue value
fromKVValueViaFFI (KVArrayBufferValueViaFFI value) = KVArrayBufferValue value
fromKVValueViaFFI (KVStreamValueViaFFI value) = KVStreamValue (readableStreamFromJSVal value)

fromKVMetadataViaFFI :: (Maybe KVValueViaFFI, Maybe Text, Maybe Text) -> KVMetadataResult
fromKVMetadataViaFFI (value, metadata, cacheStatus) =
    KVMetadataResult (fmap fromKVValueViaFFI value) metadata cacheStatus

toKVPutValueViaFFI :: KVPutValue -> KVValueViaFFI
toKVPutValueViaFFI (KVPutText value) = KVTextValueViaFFI value
toKVPutValueViaFFI (KVPutBytes value) = KVArrayBufferValueViaFFI value
toKVPutValueViaFFI (KVPutStream value) = KVStreamValueViaFFI (readableStreamToJSVal value)

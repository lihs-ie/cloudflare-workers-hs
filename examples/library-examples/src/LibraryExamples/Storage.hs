module LibraryExamples.Storage (storageScenario) where

import Cloudflare.Workers.Binding.KV
import Cloudflare.Workers.Cache
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Streaming
import Data.Aeson (Value, object, (.=))
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as Lazy
import Data.Maybe (isJust)
import Data.Text (Text)
import Data.Time.Clock.POSIX (getPOSIXTime)

-- Each scenario has a separate key space; the TTL scenario deliberately uses
-- the platform's minimum supported 60 seconds, with the test waiting outside IO.
storageScenario :: KV -> Text -> IO Value
storageScenario kv "metadata" = do
  let options = kvPutDefaultOptions{kvPutOptionsMetadata = Just "{\"version\":2}"}
  kvPut kv "metadata:a" (KVPutText "guide") options
  kvPut kv "metadata:b" (KVPutText "settings") options
  batch <- kvGetManyWithMetadata kv (KVKeyBatch "metadata:a" ["metadata:missing"]) KVBulkReadText kvReadDefaultOptions
  first <- kvList kv (Just "metadata:") Nothing (Just 1)
  second <- kvList kv (Just "metadata:") (kvListResultCursor first) (Just 1)
  kvDelete kv "metadata:a"
  deleted <- kvGet kv "metadata:a" KVReadText kvReadDefaultOptions
  kvDelete kv "metadata:b"
  pure $ object
    [ "batch" .= map (\(key, result) -> object
        ["key" .= key, "value" .= textValue (kvMetadataResultValue result), "metadata" .= kvMetadataResultMetadata result]) (kvBulkMetadataResultValues batch)
    , "first" .= map kvListKeyName (kvListResultKeys first)
    , "second" .= map kvListKeyName (kvListResultKeys second)
    , "firstComplete" .= kvListResultListComplete first
    , "deleted" .= not (isJust deleted)
    ]
storageScenario kv "formats" = do
  kvPut kv "formats:json" (KVPutText "{\"enabled\":true}") kvPutDefaultOptions
  json <- kvGet kv "formats:json" KVReadJSON kvReadDefaultOptions
  kvPut kv "formats:binary" (KVPutBytes (Bytes.pack [0,128,255])) kvPutDefaultOptions
  binary <- kvGet kv "formats:binary" KVReadArrayBuffer kvReadDefaultOptions
  stream <- readableStreamFromProducer $ \emit -> emit "stream value" >> pure StreamProducerCompleted
  kvPut kv "formats:stream" (KVPutStream stream) kvPutDefaultOptions
  streamed <- kvGet kv "formats:stream" KVReadStream kvReadDefaultOptions
  bytes <- case streamed of
    Just (KVStreamValue value) -> either (fail . show) pure =<< readableStreamToLazyByteString 1024 value
    _ -> fail "KV stream value missing"
  mapM_ (kvDelete kv) ["formats:json", "formats:binary", "formats:stream"]
  pure $ object ["json" .= case json of { Just (KVJSONValue value) -> Just value; _ -> Nothing }
    , "binary" .= case binary of { Just (KVArrayBufferValue value) -> Bytes.unpack value; _ -> [] }
    , "stream" .= Lazy.unpack bytes]
storageScenario kv "ttl-write" = do
  kvPut kv "expiry:guide" (KVPutText "temporary") kvPutDefaultOptions{kvPutOptionsExpirationTtl = Just 60}
  listing <- kvList kv (Just "expiry:") Nothing Nothing
  pure $ object ["expirations" .= map kvListKeyExpiration (kvListResultKeys listing)]
storageScenario kv "ttl-read" = do
  value <- kvGet kv "expiry:guide" KVReadText kvReadDefaultOptions
  pure $ object ["value" .= textValue value]
-- Separate operations let regional clients observe the same key over time.
storageScenario kv "propagation-write" = do
  kvPut kv "regional:guide" (KVPutText "initial") kvPutDefaultOptions{kvPutOptionsExpirationTtl = Just 180}
  pure $ object ["written" .= True]
storageScenario kv "propagation-update" = do
  kvPut kv "regional:guide" (KVPutText "updated") kvPutDefaultOptions{kvPutOptionsExpirationTtl = Just 180}
  pure $ object ["written" .= True]
storageScenario kv "propagation-read" = do
  value <- kvGet kv "regional:guide" KVReadText (KVReadOptions (Just 30))
  pure $ object ["value" .= textValue value]
-- Leave headroom above the 60-second minimum for transit and clock rounding.
storageScenario kv "absolute-write" = do
  expiration <- (+ 120) . floor <$> getPOSIXTime
  kvPut kv "regional:absolute" (KVPutText "temporary") kvPutDefaultOptions{kvPutOptionsExpiration = Just expiration}
  pure $ object ["expiration" .= expiration]
storageScenario kv "absolute-read" = do
  value <- kvGet kv "regional:absolute" KVReadText (KVReadOptions (Just 30))
  pure $ object ["value" .= textValue value]
storageScenario kv "regional-cleanup" = do
  kvDelete kv "regional:guide"
  kvDelete kv "regional:absolute"
  pure $ object ["deleted" .= True]
storageScenario kv "json-metadata" = do
  expiration <- (+ 120) . floor <$> getPOSIXTime
  kvPut kv "jsonmeta:value" (KVPutText "{\"enabled\":true}") kvPutDefaultOptions{kvPutOptionsMetadata = Just "{\"revision\":1}", kvPutOptionsExpiration = Just expiration}
  single <- kvGetWithMetadata kv "jsonmeta:value" KVReadJSON (KVReadOptions (Just 30))
  missing <- kvGetWithMetadata kv "jsonmeta:missing" KVReadText kvReadDefaultOptions
  bulk <- kvGetMany kv (KVKeyBatch "jsonmeta:value" ["jsonmeta:missing"]) KVBulkReadJSON kvReadDefaultOptions
  enriched <- kvGetManyWithMetadata kv (KVKeyBatch "jsonmeta:value" ["jsonmeta:missing"]) KVBulkReadJSON kvReadDefaultOptions
  listed <- kvList kv (Just "jsonmeta:") Nothing Nothing
  kvDelete kv "jsonmeta:value"
  pure $ object ["expiration" .= map kvListKeyExpiration (kvListResultKeys listed), "listedMetadata" .= map kvListKeyMetadata (kvListResultKeys listed)
    , "value" .= jsonValue (kvMetadataResultValue single), "metadata" .= kvMetadataResultMetadata single
    , "missing" .= not (isJust (kvMetadataResultValue missing))
    , "bulk" .= map (\(key,value) -> object ["key" .= key, "value" .= jsonValue value]) (kvBulkResultValues bulk)
    , "metadataBulk" .= map (\(key,value) -> object ["key" .= key, "value" .= jsonValue (kvMetadataResultValue value), "metadata" .= kvMetadataResultMetadata value]) (kvBulkMetadataResultValues enriched)]
storageScenario _ "cache-policy" = do
  cache <- cacheStorage >>= (`cacheOpen` "private-guide")
  let policies = [("private", CachePrivate (Just 60) Nothing Nothing), ("no-store", CacheNoStore)]
      tag = cacheTagHeader ["guide", "settings"]
  results <- mapM (\(name, policy) -> do
    let key = CacheURL ("https://library-examples.invalid/policy/" <> name)
        directive = renderCacheControl policy
        headers = headersFromList (("Cache-Control", directive) : maybe [] pure tag)
    cachePut cache key (createResponse (Status 200) headers (ResponseBodyBytes "personal guide"))
    found <- cacheMatch cache key cacheQueryDefaultOptions
    pure $ object ["policy" .= directive, "hit" .= isJust found]) policies
  pure $ object ["policies" .= results, "tag" .= tag, "emptyTag" .= cacheTagHeader []]
storageScenario _ "cache-write" = do
  cache <- cacheStorage >>= (`cacheOpen` "expiring-guide")
  cachePut cache expiryKey (createResponse (Status 200)
    (headersFromList [("Cache-Control", renderCacheControl (CachePublic (Just 2) Nothing Nothing))])
    (ResponseBodyBytes "temporary guide"))
  found <- cacheMatch cache expiryKey cacheQueryDefaultOptions
  pure $ object ["hit" .= isJust found]
storageScenario _ "cache-read" = do
  cache <- cacheStorage >>= (`cacheOpen` "expiring-guide")
  found <- cacheMatch cache expiryKey cacheQueryDefaultOptions
  pure $ object ["hit" .= isJust found]
storageScenario _ "regional-cache-write" = do
  cache <- cacheStorage >>= (`cacheOpen` "regional-guide")
  cachePut cache regionalKey (createResponse (Status 200)
    (headersFromList [("Cache-Control", "public, max-age=120")]) (ResponseBodyBytes "regional guide"))
  found <- cacheMatch cache regionalKey cacheQueryDefaultOptions
  pure $ object ["hit" .= isJust found]
storageScenario _ "regional-cache-read" = do
  cache <- cacheStorage >>= (`cacheOpen` "regional-guide")
  found <- cacheMatch cache regionalKey cacheQueryDefaultOptions
  pure $ object ["hit" .= isJust found]
storageScenario _ "regional-cache-delete" = do
  cache <- cacheStorage >>= (`cacheOpen` "regional-guide")
  deleted <- cacheDelete cache regionalKey cacheQueryDefaultOptions
  pure $ object ["deleted" .= deleted]
storageScenario _ _ = fail "unknown storage scenario"

regionalKey :: CacheKey
regionalKey = CacheURL "https://library-examples.invalid/regional-guide"

expiryKey :: CacheKey
expiryKey = CacheURL "https://library-examples.invalid/expiring-guide"

textValue :: Maybe KVValue -> Maybe Text
textValue (Just (KVTextValue value)) = Just value
textValue _ = Nothing

jsonValue :: Maybe KVValue -> Maybe Text
jsonValue (Just (KVJSONValue value)) = Just value
jsonValue _ = Nothing

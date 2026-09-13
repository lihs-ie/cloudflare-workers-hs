module Support.Storage (storageValidation) where

import Cloudflare.Workers.Binding.KV
import Cloudflare.Workers.Cache
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.URL (parseURL)
import ExampleSupport.Interop (textToJSVal, jsValToText)
import Control.Exception (try)
import Data.Either (isLeft)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8)
import Data.Maybe (isJust, isNothing)
import GHC.Wasm.Prim (JSVal)

storageValidation :: JSVal -> JSVal -> IO JSVal
storageValidation namespace rawMode = do
  mode <- jsValToText rawMode
  result <- case mode of
    "validation" -> kvValidation (KV namespace)
    "cache-validation" -> cacheValidation
    "cache-method" -> cacheMethod
    _ -> fail "Unknown storage fixture"
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode result)))

kvValidation :: KV -> IO Value
kvValidation kv = do
  future <- try @KVError $ kvPut kv "validation:far-future" (KVPutText "must not persist") kvPutDefaultOptions{kvPutOptionsExpiration = Just 4102444800}
  futureAbsent <- kvGet kv "validation:far-future" KVReadText kvReadDefaultOptions
  ttl <- try @KVError $ kvPut kv "validation:ttl" (KVPutText "must not persist") kvPutDefaultOptions{kvPutOptionsExpirationTtl = Just 59}
  absent <- kvGet kv "validation:ttl" KVReadText kvReadDefaultOptions
  kvPut kv "validation:json" (KVPutText "not JSON") kvPutDefaultOptions
  malformed <- try @KVError $ kvGet kv "validation:json" KVReadJSON kvReadDefaultOptions
  invalidCache <- try @KVError $ kvGet kv "validation:json" KVReadText (KVReadOptions (Just 29))
  excessive <- try @KVError $ kvGetMany kv (KVKeyBatch "validation:json" (replicate 100 "missing")) KVBulkReadText kvReadDefaultOptions
  acceptedBatch <- kvGetMany kv (KVKeyBatch "validation:json" ["validation:missing:" <> Text.pack (show index) | index <- [1..99 :: Int]]) KVBulkReadText kvReadDefaultOptions
  duplicate <- kvGetMany kv (KVKeyBatch "validation:json" ["validation:json", "validation:missing"]) KVBulkReadText kvReadDefaultOptions
  invalidLimit <- try @KVError $ kvList kv (Just "validation:") Nothing (Just 0)
  invalidCursor <- try @KVError $ kvList kv (Just "validation:") (Just "!not-base64!") (Just 1)
  negativeLimit <- try @KVError $ kvList kv Nothing Nothing (Just (-1))
  recovered <- kvGet kv "validation:json" KVReadText (KVReadOptions (Just 30))
  mapM_ (kvDelete kv) ["validation:ttl", "validation:json", "validation:far-future"]
  pure $ object ["farFutureRejected" .= case future of { Left (KVPutFailed _) -> True; _ -> False }
    , "farFutureAbsent" .= isNothing futureAbsent
    , "ttlRejected" .= case ttl of { Left (KVPutFailed _) -> True; _ -> False }
    , "ttlAbsent" .= isNothing absent
    , "jsonRejected" .= case malformed of { Left (KVGetFailed _) -> True; _ -> False }
    , "cacheTtlRejected" .= case invalidCache of { Left (KVInvalidCacheTtl 29) -> True; _ -> False }
    , "batchRejected" .= case excessive of { Left (KVTooManyKeys 101) -> True; _ -> False }
    , "acceptedBatchCount" .= length (kvBulkResultValues acceptedBatch)
    , "duplicateValues" .= map (textValue . snd) (kvBulkResultValues duplicate)
    , "zeroLimitKeys" .= either (const []) (map kvListKeyName . kvListResultKeys) invalidLimit
    , "malformedCursorKeys" .= either (const []) (map kvListKeyName . kvListResultKeys) invalidCursor
    , "negativeLimitAccepted" .= either (const False) (const True) negativeLimit
    , "malformedCursorAccepted" .= either (const False) (const True) invalidCursor
    , "recovered" .= textValue recovered]

cacheValidation :: IO Value
cacheValidation = do
  cache <- cacheStorage >>= (`cacheOpen` "validation-guide")
  let key = CacheURL "https://library-examples.invalid/validation"
      response status extra = createResponse (Status status) (headersFromList (("Cache-Control", "public, max-age=60") : extra)) (ResponseBodyBytes "guide")
  partial <- try @CacheError $ cachePut cache key (response 206 [])
  vary <- try @CacheError $ cachePut cache key (response 200 [("Vary", "*")])
  absent <- cacheMatch cache key cacheQueryDefaultOptions
  cachePut cache key (response 200 [])
  recovered <- cacheMatch cache key cacheQueryDefaultOptions
  deleted <- cacheDelete cache key cacheQueryDefaultOptions
  deletedAgain <- cacheDelete cache key cacheQueryDefaultOptions
  pure $ object ["partialRejected" .= isLeft partial, "varyRejected" .= isLeft vary
    , "partialClassification" .= cacheFailure partial, "varyClassification" .= cacheFailure vary
    , "absent" .= isNothing absent, "recovered" .= isJust recovered
    , "deleted" .= deleted, "deletedAgain" .= deletedAgain]

cacheMethod :: IO Value
cacheMethod = do
  cache <- cacheStorage >>= (`cacheOpen` "fixture-method-guide")
  url <- maybe (fail "Invalid fixture URL") pure (parseURL "https://library-examples.invalid/method-guide")
  let request method = Request method url Nothing (headersFromList []) Nothing Nothing
      getKey = CacheRequest (request GET)
      postKey = CacheRequest (request POST)
      response = createResponse (Status 200) (headersFromList [("Cache-Control", "public, max-age=60")]) (ResponseBodyBytes "guide")
  rejected <- try @CacheError $ cachePut cache postKey response
  cachePut cache getKey response
  strict <- cacheMatch cache postKey cacheQueryDefaultOptions
  ignored <- cacheMatch cache postKey (CacheQueryOptions True)
  strictDelete <- cacheDelete cache postKey cacheQueryDefaultOptions
  ignoredDelete <- cacheDelete cache postKey (CacheQueryOptions True)
  absent <- cacheMatch cache getKey cacheQueryDefaultOptions
  pure $ object ["putRejected" .= isLeft rejected, "classification" .= cacheFailure rejected, "message" .= case rejected of { Left (CachePutRejected _ message) -> message; _ -> "" }, "strictMiss" .= isNothing strict
    , "ignoredHit" .= isJust ignored, "strictDelete" .= strictDelete
    , "ignoredDelete" .= ignoredDelete, "absent" .= isNothing absent]

textValue :: Maybe KVValue -> Maybe Text
textValue (Just (KVTextValue value)) = Just value
textValue _ = Nothing

cacheFailure :: Either CacheError () -> String
cacheFailure (Left (CachePutRejected kind _)) = show kind
cacheFailure (Left _) = "unexpected-error"
cacheFailure (Right ()) = "unexpected-success"

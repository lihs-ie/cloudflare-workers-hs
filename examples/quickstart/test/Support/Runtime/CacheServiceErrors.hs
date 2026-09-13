module Support.Runtime.CacheServiceErrors (cacheServiceErrorsProbe) where

import Cloudflare.Workers.Binding.Assets
import Cloudflare.Workers.Binding.DurableObject (DurableObjectValue (..))
import Cloudflare.Workers.Binding.ServiceBinding
import Cloudflare.Workers.Cache
import Cloudflare.Workers.Headers (headersFromList, headersToList)
import Cloudflare.Workers.HTTP
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Cloudflare.Workers.Reactor (WorkersExecutionContext (..))
import Cloudflare.Workers.URL (parseURL)
import Cloudflare.Workers.Streaming (readableStreamToLazyByteString)
import Control.Exception (SomeException, displayException, fromException, try)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as LazyBytes
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Encoding
import GHC.Wasm.Prim (JSVal)

-- Every operation crosses a public API. Native-shaped failing objects are supplied
-- by the caller, and the result records the typed exception rather than merely
-- observing that a JavaScript promise rejected.
cacheServiceErrorsProbe :: JSVal -> JSVal -> IO JSVal
cacheServiceErrorsProbe handle commandValue = do
    command <- jsValToText commandValue
    request <- case parseURL "https://cache.example/fixture?key=1" of
        Nothing -> fail "Invalid fixture URL"
        Just url -> pure (Request GET url Nothing (headersFromList [("x-fixture", "request")]) Nothing Nothing)
    outcome <- try @SomeException $ case command of
        "assets-contract" -> do
            result <- try @AssetsError (assetsFetch (Assets handle) request)
            case result of
                Left failure -> pure (diagnose (AssetsFetchFailed "Error: fetch failed") (AssetsFetchFailed "other") failure)
                Right response -> summarizeResponse response
        "service-contract" -> do
            result <- try @ServiceBindingError (serviceFetch (ServiceBinding handle) request)
            case result of
                Left failure -> pure (diagnose (ServiceFetchFailed "Error: fetch failed") (ServiceFetchFailed "other") failure)
                Right response -> summarizeResponse response
        "policy-contract" -> pure policyContract
        "purge-contract" -> do
            result <- cachePurge (WorkersExecutionContext handle) (PurgeTags ["tag-one"])
            let expected = CachePurgeResult False [CachePurgeError 42 "policy rejection"]
            pure (diagnose expected (CachePurgeResult False []) result)
        "purge-failure-contract" -> do
            result <- try @CachePurgeFailed (cachePurge (WorkersExecutionContext handle) PurgeEverything)
            case result of
                Left failure -> pure (diagnose (CachePurgeFailed "Error: purge failed") (CachePurgeFailed "other") failure)
                Right _ -> fail "Expected typed purge rejection"
        "assets" -> summarizeResponse =<< assetsFetch (Assets handle) request
        "service" -> summarizeResponse =<< serviceFetch (ServiceBinding handle) request
        "service-invalid-request" -> summarizeResponse =<< serviceFetch (ServiceBinding handle) request{requestMethodField = OtherMethod "bad method"}
        "call" -> do
            value <- textToJSVal "argument"
            result <- serviceCall (ServiceBinding handle) "operation" [DurableObjectValue value]
            case result of
                Left failure -> pure (object ["callError" .= show failure])
                Right (DurableObjectValue output) -> do
                    text <- jsValToText output
                    pure (object ["output" .= text])
        "purge-tags" -> purge (PurgeTags ["tag-one", "tag-two"])
        "purge-prefixes" -> purge (PurgePathPrefixes ["/one", "/two"])
        "purge-all" -> purge PurgeEverything
        _ -> do
            storage <- cacheStorage
            cache <- cacheOpen storage "coverage-errors"
            case command of
                "open" -> pure (object ["opened" .= True])
                "put" -> do
                    cachePut cache (CacheRequest request) (createResponse (Status 200) (headersFromList []) (ResponseBodyBytes "payload"))
                    pure (object ["stored" .= True])
                "delete" -> do
                    deleted <- cacheDelete cache (CacheRequest request) (CacheQueryOptions True)
                    pure (object ["deleted" .= deleted])
                "put-contract" -> do
                    result <- try @CacheError (cachePut cache (CacheURL "https://cache.example/fixture") (createResponse (Status 200) (headersFromList []) (ResponseBodyBytes "payload")))
                    case result of
                        Left failure@(CachePutRejected kind _) -> pure (object
                            [ "failure" .= diagnose (CachePutRejected CachePutInvalidMethod "Error: request method invalid") (CachePutRejected CachePutInvalidMethod "other") failure
                            , "kind" .= diagnose CachePutInvalidMethod CachePutOther kind
                            ])
                        _ -> fail "Expected typed cache put rejection"
                "match-read" -> do
                    matched <- cacheMatch cache (CacheURL "https://cache.example/fixture") cacheQueryDefaultOptions
                    case matched of
                        Just response -> case responseBody response of
                            ResponseBodyStream stream -> do
                                result <- readableStreamToLazyByteString 1024 stream
                                bytes <- either (fail . show) pure result
                                pure (object ["bytes" .= LazyBytes.unpack bytes])
                            _ -> fail "Expected cached stream body"
                        Nothing -> fail "Expected cache hit"
                "match" -> do
                    matched <- cacheMatch cache (CacheURL "https://cache.example/fixture") cacheQueryDefaultOptions
                    maybe (pure (object ["missing" .= True])) summarizeResponse matched
                _ -> fail "Unknown cache/service scenario"
    let output = either (\failure -> object ["ok" .= False, "kind" .= failureKind failure, "message" .= displayException failure])
            (\value -> object ["ok" .= True, "value" .= value]) outcome
    textToJSVal (Encoding.decodeUtf8 (LazyBytes.toStrict (encode output)))
  where
    purge options = do
        result <- cachePurge (WorkersExecutionContext handle) options
        pure (object ["success" .= cachePurgeResultSuccess result, "errors" .= map (\error -> (cachePurgeErrorCode error, cachePurgeErrorMessage error)) (cachePurgeResultErrors result)])

summarizeResponse :: Response -> IO Value
summarizeResponse response = pure $ object
    [ "status" .= statusCode (responseStatus response)
    , "headers" .= headersToList (responseHeaders response)
    , "body" .= case responseBody response of
        ResponseBodyBytes bytes -> object ["kind" .= ("bytes" :: Text.Text), "length" .= Bytes.length bytes]
        ResponseBodyStream _ -> object ["kind" .= ("stream" :: Text.Text)]
        ResponseBodyPassthrough _ -> object ["kind" .= ("passthrough" :: Text.Text)]
        _ -> object ["kind" .= ("other" :: Text.Text)]
    ]

failureKind :: SomeException -> Text.Text
failureKind failure
    | Just (AssetsFetchFailed _) <- fromException failure = "AssetsFetchFailed"
    | Just (ServiceFetchFailed _) <- fromException failure = "ServiceFetchFailed"
    | Just (CacheOpenFailed _) <- fromException failure = "CacheOpenFailed"
    | Just (CachePutRejected kind _) <- fromException failure = "CachePutRejected:" <> Text.pack (show kind)
    | Just (CacheMatchFailed _) <- fromException failure = "CacheMatchFailed"
    | Just (CacheDeleteFailed _) <- fromException failure = "CacheDeleteFailed"
    | Just (CachePurgeFailed _) <- fromException failure = "CachePurgeFailed"
    | otherwise = "UnexpectedException"

-- A cache-policy consumer reads TTL settings and supplies concrete diagnostics
-- when an observed policy/result differs from the expected configuration.
policyContract :: Value
policyContract = object
    [ "policies" .= map describePolicy [CachePublic (Just 10) (Just 20) (Just 30), CachePrivate Nothing Nothing Nothing]
    , "directive" .= diagnose (CachePublic (Just 10) (Just 20) (Just 30)) CacheNoStore (CachePublic (Just 10) (Just 20) (Just 30))
    , "query" .= diagnose cacheQueryDefaultOptions (CacheQueryOptions True) (CacheQueryOptions False)
    , "purge" .= diagnose (PurgeTags ["tag-one"]) PurgeEverything (PurgeTags ["tag-one"])
    , "error" .= diagnose (CachePurgeError 42 "policy rejection") (CachePurgeError 42 "other") (CachePurgeError 42 "policy rejection")
    ]
  where
    describePolicy policy = object
        [ "maxAge" .= cacheControlDirectiveMaxAge policy
        , "sharedMaxAge" .= cacheControlDirectiveSMaxAge policy
        , "stale" .= cacheControlDirectiveStaleWhileRevalidate policy
        , "header" .= renderCacheControl policy
        ]

diagnose :: (Eq value, Show value) => value -> value -> value -> Value
diagnose expected different actual = object
    [ "matches" .= (actual == expected)
    , "differs" .= (actual /= different)
    , "summary" .= show actual
    , "batch" .= showList [actual] ""
    , "nested" .= showsPrec 11 actual ""
    ]

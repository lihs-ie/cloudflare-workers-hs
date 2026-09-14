{-# LANGUAGE DataKinds #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}
{-# LANGUAGE TypeOperators #-}

-- | Identical routing scenarios for host and real WASM tests. The caller supplies
-- its execution context; this fixture never constructs a host-only JS value.
module Support.Runtime.Routing (routingFixture) where

import Cloudflare.Workers.HTTP (Request (..), Response (..), ResponseBody (..), Status (..), createResponse)
import Cloudflare.Workers.HTTP qualified as HTTP
import Cloudflare.Workers.Headers qualified as Headers
import Cloudflare.Workers.URL (parseURL)
import Cloudflare.Workers.Streaming (ReadableStreamReadError (..), ReadableStream, readableStreamFromProducer, StreamProducerOutcome (..))
import Control.Monad.IO.Class (liftIO)
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as LBS
import Data.Text qualified as Text
import Control.Monad (unless)
import Servant.Cloudflare.Workers.CacheControl
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Control.Monad.Except (throwError)
import Data.IORef (newIORef, modifyIORef', readIORef)
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Servant.API
import Servant.Cloudflare.Workers.Error (err400)
import Servant.Cloudflare.Workers.Server

routingFixture :: Text -> Request -> WorkersExecutionContext -> IO Response
routingFixture mode request context = case mode of
  "body-reader-matrix" -> runBodyReaderMatrix request context
  "matrix" -> runRoutingMatrix request context
  "no-content-get" -> serveWithContext (Proxy @(NoContentVerb 'GET)) EmptyContext (pure NoContent) request context ()
  "no-content-delete" -> serveWithContext (Proxy @(NoContentVerb 'DELETE)) EmptyContext (pure NoContent) request context ()
  "no-content-failure" -> serveWithContext (Proxy @(NoContentVerb 'DELETE)) EmptyContext (throwError err400) request context ()
  "head" -> serveWithContext (Proxy @(Get '[PlainText] (Headers '[Header "X-Result" Text] Text))) EmptyContext
    (pure (addHeader ("present" :: Text) ("payload" :: Text))) request context ()
  "method-choice" -> serveWithContext (Proxy @(Get '[PlainText] Text :<|> Post '[PlainText] Text)) EmptyContext
    (pure "get" :<|> pure "post") request context ()
  "parameters" -> serveWithContext (Proxy @(QueryParam "one" Int :> QueryParams "many" Int :> QueryFlag "flag" :> Header "X-Count" Int :> Get '[JSON] (Maybe Int, [Int], Bool, Maybe Int))) EmptyContext
    (\one many flag count -> pure (one, many, flag, count)) request context ()
  "capture-raw" -> serveWithContext (Proxy @(Capture "value" Int :> Header "X-Count" Int :> Raw)) EmptyContext
    (\value count _ _ _ -> pure (createResponse (Status 200) (Headers.headersFromList []) (ResponseBodyLazyBytes (Aeson.encode (value, count))))) request context ()
  "native-stream" -> serveWithContext (Proxy @(Stream 'GET 206 NoFraming OctetStream (Headers '[Header "X-Stream" Text] ReadableStream))) EmptyContext
    (do stream <- liftIO (readableStreamFromProducer (\emit -> emit "stream-body" >> pure StreamProducerCompleted))
        pure (addHeader ("present" :: Text) stream)) request context ()
  "body" -> serveWithContext (Proxy @(ReqBody '[JSON] Text :> Post '[JSON] Text)) EmptyContext pure request context ()
  "capture-choice" -> serveWithContext (Proxy @((Capture "value" Int :> Get '[PlainText] Text) :<|> (Capture "value" Text :> Get '[PlainText] Text))) EmptyContext
    ((\_ -> pure "integer") :<|> (\_ -> pure "text")) request context ()
  "cache-all" -> serveWithContext (Proxy @(CacheControlled '[Public, MaxAge 60, SMaxAge 120, StaleWhileRevalidate 30] :> Get '[PlainText] Text)) EmptyContext (pure "cache") request context ()
  "cache-empty" -> serveWithContext (Proxy @(CacheControlled '[] :> Get '[PlainText] Text)) EmptyContext (pure "cache") request context ()
  "cache-private" -> serveWithContext (Proxy @(CacheControlled '[Public, MaxAge 10, Private, MaxAge 20] :> Get '[PlainText] Text)) EmptyContext (pure "cache") request context ()
  "cache-no-store" -> serveWithContext (Proxy @(CacheControlled '[MaxAge 60, NoStore] :> Get '[PlainText] Text)) EmptyContext (pure "cache") request context ()
  "cache-raw" -> serveWithContext (Proxy @(CacheControlled '[Public] :> Raw)) EmptyContext
    (\_ req _ -> pure (createResponse (if Headers.headerLookup "X-Error" (requestHeaders req) == Just "yes" then Status 400 else Status 200) (requestHeaders req) (ResponseBodyBytes "raw"))) request context ()
  "capture-all" -> serveWithContext (Proxy @(CaptureAll "values" Int :> Get '[JSON] [Int])) EmptyContext pure request context ()
  "empty" -> serveWithContext (Proxy @EmptyAPI) EmptyContext EmptyServer request context ()
  "empty-prefix" -> serveWithContext (Proxy @(EmptyAPI :> Get '[JSON] Int)) EmptyContext (pure 42) request context ()
  "named-context" -> serveWithContext (Proxy @(WithNamedContext "nested" '[Int] (Get '[JSON] Int)))
    (NamedContext @"nested" ((42 :: Int) :. EmptyContext) :. EmptyContext) (pure 42) request context ()
  _ -> fail "Unknown routing fixture mode"


-- | Exercise the same request-boundary matrix in both runtimes. Input body
-- readers are deliberately deterministic: native stream marshalling is tested
-- separately, while these cases assert the Servant interpreter's decisions.
runRoutingMatrix :: Request -> WorkersExecutionContext -> IO Response
runRoutingMatrix seed context = do
  names <- sequence
    [ check "parameter-defaults" "parameters" "/" HTTP.GET [] Nothing 200 (Just "[null,[],false,null]") []
    , check "parameter-values" "parameters" "/?one=7&many=1&many[]=2&flag=true" HTTP.GET [("X-Count", "4")] Nothing 200 (Just "[7,[1,2],true,4]") []
    , check "parameter-valueless" "parameters" "/?one&many&flag=false" HTTP.GET [] Nothing 200 (Just "[null,[],false,null]") []
    , check "parameter-invalid-single" "parameters" "/?one=x" HTTP.GET [] Nothing 400 Nothing []
    , check "parameter-invalid-many" "parameters" "/?many=1&many=x" HTTP.GET [] Nothing 400 Nothing []
    , check "parameter-invalid-header" "parameters" "/" HTTP.GET [("X-Count", "x")] Nothing 400 Nothing []
    , check "accept-before-query" "parameters" "/?one=x" HTTP.GET [("Accept", "image/png")] Nothing 406 Nothing []
    , check "method-before-query" "parameters" "/?one=x" HTTP.DELETE [] Nothing 405 Nothing [("Allow", Just "GET, HEAD")]
    , check "body-valid" "body" "/" HTTP.POST jsonHeaders (Just (Right "\"hello\"")) 200 (Just "\"hello\"") []
    , check "body-invalid-json" "body" "/" HTTP.POST jsonHeaders (Just (Right "invalid")) 400 Nothing []
    , check "body-wrong-shape" "body" "/" HTTP.POST jsonHeaders (Just (Right "42")) 400 Nothing []
    , check "body-absent" "body" "/" HTTP.POST jsonHeaders Nothing 400 Nothing []
    , check "body-unsupported-type" "body" "/" HTTP.POST [("Content-Type", "image/png")] Nothing 415 Nothing []
    , check "body-too-large" "body" "/" HTTP.POST jsonHeaders (Just (Left ReadableStreamExceededByteLimit)) 413 Nothing []
    , check "capture-first" "capture-choice" "/42" HTTP.GET [] Nothing 200 (Just "integer") []
    , check "capture-fallback" "capture-choice" "/text" HTTP.GET [] Nothing 200 (Just "text") []
    , check "capture-missing" "capture-choice" "/" HTTP.GET [] Nothing 404 Nothing []
    , check "cache-all-directives" "cache-all" "/" HTTP.GET [] Nothing 200 (Just "cache") [("Cache-Control", Just "public, max-age=60, s-maxage=120, stale-while-revalidate=30"), ("Vary", Just "Accept")]
    , check "cache-empty-directives" "cache-empty" "/" HTTP.GET [] Nothing 200 (Just "cache") [("Cache-Control", Just "private")]
    , check "cache-last-directive" "cache-private" "/" HTTP.GET [] Nothing 200 (Just "cache") [("Cache-Control", Just "private, max-age=20")]
    , check "cache-no-store" "cache-no-store" "/" HTTP.GET [] Nothing 200 (Just "cache") [("Cache-Control", Just "no-store")]
    , check "cache-error" "cache-raw" "/" HTTP.GET [("X-Error", "yes")] Nothing 400 (Just "raw") [("Cache-Control", Just "no-store"), ("Vary", Nothing)]
    , check "cache-preserved" "cache-raw" "/" HTTP.GET [("Cache-Control", "no-cache")] Nothing 200 Nothing [("Cache-Control", Just "no-cache")]
    , check "cache-vary-preserved" "cache-raw" "/" HTTP.GET [("Vary", "Origin")] Nothing 200 Nothing [("Vary", Just "Origin")]
    ]
  pure (createResponse (Status 200) (Headers.headersFromList [("Content-Type", "application/json")]) (ResponseBodyLazyBytes (Aeson.encode names)))
  where
    jsonHeaders = [("Content-Type", "application/json")]
    check name mode path method headers body status expectedBody expectedHeaders = do
      url <- maybe (fail "Invalid fixture URL") pure (parseURL ("https://routing.example" <> path))
      let request = seed
            { requestURLField = url
            , requestMethodField = method
            , requestHeaders = Headers.headersFromList headers
            , requestBodyField = Nothing
            , requestBodyReaderField = fmap (\value _ -> pure value) body
            }
      response <- routingFixture mode request context
      unless (responseStatus response == Status status) (fail (Text.unpack name <> ": unexpected status " <> show (responseStatus response)))
      mapM_ (\expected -> unless (bodyBytes response == expected) (fail (Text.unpack name <> ": unexpected body"))) expectedBody
      mapM_ (\(key, expected) -> unless (Headers.headerLookup key (responseHeaders response) == expected) (fail (Text.unpack name <> ": unexpected header " <> Text.unpack key))) expectedHeaders
      pure name
    bodyBytes response = case responseBody response of
      ResponseBodyBytes bytes -> LBS.fromStrict bytes
      ResponseBodyLazyBytes bytes -> bytes
      _ -> error "Routing matrix expected a buffered response"


runBodyReaderMatrix :: Request -> WorkersExecutionContext -> IO Response
runBodyReaderMatrix seed context = do
  names <- sequence
    [ check "method" HTTP.GET jsonHeaders (Right "\"ok\"") 405 0
    , check "accept" HTTP.POST [("Content-Type", "application/json"), ("Accept", "image/png")] (Right "\"ok\"") 406 0
    , check "content" HTTP.POST [("Content-Type", "image/png")] (Right "\"ok\"") 415 0
    , check "missing-content-type" HTTP.POST [] (Right "\"ok\"") 415 0
    , check "empty-body" HTTP.POST jsonHeaders (Right "") 400 1
    , check "limit" HTTP.POST jsonHeaders (Left ReadableStreamExceededByteLimit) 413 1
    , check "recovery" HTTP.POST jsonHeaders (Right "\"ok\"") 200 1
    ]
  pure (createResponse (Status 200) (Headers.headersFromList [("Content-Type", "application/json")]) (ResponseBodyLazyBytes (Aeson.encode names)))
  where
    jsonHeaders = [("Content-Type", "application/json")]
    check :: Text -> HTTP.Method -> [(Text, Text)] -> Either ReadableStreamReadError LBS.ByteString -> Int -> Int -> IO Text
    check name method headers body expectedStatus expectedReads = do
      reads <- newIORef (0 :: Int)
      let request = seed
            { requestMethodField = method
            , requestHeaders = Headers.headersFromList headers
            , requestBodyField = Nothing
            , requestBodyReaderField = Just (\_ -> modifyIORef' reads (+1) >> pure body)
            }
      response <- routingFixture "body" request context
      actualReads <- readIORef reads
      unless (responseStatus response == Status expectedStatus && actualReads == expectedReads)
        (fail (Text.unpack name <> ": status/body-read mismatch " <> show (responseStatus response, actualReads)))
      pure name

{-# LANGUAGE DataKinds #-}
{-# LANGUAGE FlexibleInstances #-}
{-# LANGUAGE MultiParamTypeClasses #-}
{-# LANGUAGE TypeFamilies #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}
{-# LANGUAGE TypeOperators #-}

-- | Consumer-visible routing contracts using a caller-owned native stream.
module Support.Runtime.RoutingCoverage (routingCoverageFixture) where

import Cloudflare.Workers.HTTP (Request, Response, responseBody, ResponseBody (..), Status (..), createResponse)
import Cloudflare.Workers.Headers qualified as Headers
import Cloudflare.Workers.Reactor (WorkersExecutionContext, passThroughOnException)
import Control.Monad.Reader (ask, local, reader)
import Control.Monad.Except (catchError, throwError)
import Control.Applicative (liftA2)
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO
import Cloudflare.Workers.HTTP qualified as HTTP
import Cloudflare.Workers.URL (parseURL)
import Servant.Cloudflare.Workers.EdgeDataCenter
import GHC.Generics (Generic, from, to)
import Servant.API.Generic ((:-))
import Control.Monad.IO.Class (liftIO)
import Servant.Cloudflare.Workers.Handler (askExecutionContext)
import Servant.Cloudflare.Workers.Generic (AsWorker)
import Servant.Cloudflare.Workers.Assets (serveWithAssets)
import Servant.Cloudflare.Workers.CacheControl
import Servant.Cloudflare.Workers.Server.Internal.Router
import Servant.Cloudflare.Workers.Server.Internal.Delayed
import Servant.Cloudflare.Workers.Server.Internal.RouteResult
import Support.Runtime.RouterInternals (runForwardingContracts)
import Data.Typeable (typeRep)
import Data.Map.Strict qualified as Map
import Cloudflare.Workers.Streaming (ReadableStream)
import Data.Aeson (encode)
import Data.Aeson qualified
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import Data.ByteString.Lazy qualified as LBS
import Servant.Cloudflare.Workers.Error
import Servant.API
import Servant.API.ContentTypes (AllCTRender (..), AllCTUnrender (..), AllMime (..))
import Network.HTTP.Media qualified as Media
import Servant.API.ResponseHeaders (GetHeaders (..))
import Data.ByteString qualified as BS
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal (EmptyServer (..))

routingCoverageFixture :: Text -> Request -> WorkersExecutionContext -> ReadableStream -> IO Response
routingCoverageFixture mode request context source = case mode of
  "custom-parser-helper" -> pure (jsonResponse
    ( handleCTypeH (Proxy @'[ContractMime]) "application/x-contract" "input" :: Maybe (Either String Text)
    , handleCTypeH (Proxy @'[ContractMime]) "text/plain" "input" :: Maybe (Either String Text)))
  "single-route-diagnostic" -> pure (jsonResponse (show (Fail err413 :: RouteResult Int)))
  "custom-typeclass-response" -> serveWithContext
    (Proxy @(ReqBody '[ContractMime] Text :> Verb ContractMethod 207 '[ContractMime] (Headers '[Header "X-Contract" Text] Text))) EmptyContext
    (\body -> pure (addHeader ("custom" :: Text) (body <> "-response")))
    request{HTTP.requestHeaders=Headers.headersFromList [("Content-Type",maybe "application/x-contract" id (Headers.headerLookup "Content-Type" (HTTP.requestHeaders request))),("Accept","application/x-contract")],HTTP.requestBodyReaderField=Just (\_ -> pure (Right "input"))} context ()
  "custom-typeclass-stream" -> serveWithContext
    (Proxy @(Stream ContractMethod 206 NoFraming ContractMime ReadableStream)) EmptyContext
    (pure source) request context ()
  "custom-typeclass-no-content" -> serveWithContext
    (Proxy @(NoContentVerb ContractMethod)) EmptyContext (pure NoContent) request context ()
  "empty-router-shape" -> case (route (Proxy @EmptyAPI) EmptyContext (emptyDelayed (Route EmptyServer)) :: Router () ()) of
    StaticRouter table leaves -> pure (jsonResponse (Map.null table, null leaves))
    _ -> fail "EmptyAPI must produce empty static routing table"
  "malformed-header-bytes" -> do
    response <- serveWithContext (Proxy @(Get '[JSON] (Headers '[Header "X-Malformed" Text] Text))) EmptyContext
      (pure (addHeader ("ignored" :: Text) ("body" :: Text))) request context ()
    pure (jsonResponse (Headers.headerLookup "�" (HTTP.responseHeaders response)))
  "handler-operations" -> serveWithContext (Proxy @(Get '[JSON] [Int])) EmptyContext
    (do original <- ask
        scoped <- local (+ 1) (reader (* 2))
        combined <- liftA2 (+) (pure 3) (pure 4)
        applied <- pure (+ 1) <*> pure 8
        left <- pure 10 <* pure 20
        right <- pure 30 *> pure 40
        recovered <- catchError (throwError err413) (return . serverErrorStatusCode)
        restored <- ask
        return [original,scoped,combined,applied,left,right,recovered,restored]) request context (5 :: Int)
  "delayed-operations" -> do
    result <- runDelayedIO (do
      original <- reader HTTP.requestMethod
      changed <- local (\req -> req{HTTP.requestMethodField=HTTP.POST}) (reader HTTP.requestMethod)
      combined <- liftA2 (+) (pure (2 :: Int)) (pure 3)
      replaced <- (7 :: Int) <$ pure (error "discarded delayed payload" :: Int)
      restored <- reader HTTP.requestMethod
      return (original==HTTP.GET,changed==HTTP.POST,combined,replaced,restored==HTTP.GET)) request
    case result of
      Route value -> pure (jsonResponse value)
      _ -> fail "delayed operation failed"
  "route-operations" -> do
    transformed <- runRouteResultT (RouteResultT (pure (Route (1 :: Int))) >> RouteResultT (pure (Route 2)))
    let combined = liftA2 (+) (Route 2) (Route 3)
        left = Route 4 <* Route (9 :: Int)
        right = Route (8 :: Int) *> Route 6
        sequenced = Route (7 :: Int) >> Route 10
        failed = Fail err413 >> Route (error "failed route continued" :: Int)
    pure (jsonResponse (show [combined,left,right,sequenced,transformed,failed], combined /= left))
  "context-forwarding" -> do
    let contextValues = (40 :: Int) :. EmptyContext
        req = request{HTTP.requestHeaders=Headers.headersFromList [("Content-Type","application/json")],HTTP.requestBodyReaderField=Just (\_ -> pure (Right "3"))}
    serveWithAssets [[]] (error "context API must not call assets") (Proxy @ContextMatrix) contextValues
      (pure 0 :<|> (\_ _ _ _ _ _ _ _ -> pure 2)) req context ()
  "named-routes-context" -> serveWithContext (Proxy @(NamedRoutes ContextRoutes)) ((40 :: Int) :. EmptyContext)
    (ContextRoutes (named (roundTripContextRoutes (ContextRoutes (pure 2))))) request context ()
  "no-content-context" -> serveWithContext (Proxy @(NoContentVerb 'GET)) EmptyContext
    (do ctx <- askExecutionContext; liftIO (passThroughOnException ctx); pure NoContent) request context ()
  "cache-raw-path" -> serveWithContext (Proxy @(CacheControlled '[Public] :> Raw)) EmptyContext
    (\parts _ ctx -> passThroughOnException ctx >> pure (jsonResponse parts)) request context ()
  "error-diagnostics" -> pure (jsonResponse (show err413, show [err413,err415], err413 /= err415))
  "delayed-replacement" -> do
    success <- runDelayed ("replacement" <$ emptyDelayed (Route (error "old result must not be evaluated" :: Text))) () request
    failure <- runDelayed ("replacement" <$ emptyDelayed (Fail err413 :: RouteResult Text)) () request
    pure (jsonResponse (success == Route ("replacement" :: Text), failure == Fail err413))
  "router-forwarding" -> do
    let respond seed segments _ ctx env = do
          passThroughOnException ctx
          pure (Route (jsonResponse (seed :: Text, segments, env :: Text)))
        leaf = leafRouter respond
        raw = RawRouter respond
        captured = CaptureAllRouter [] (leafRouter (\(parts, seed) residual req ctx env -> respond seed (parts <> residual) req ctx env))
        failed = RawRouter (\seed _ _ ctx _ -> passThroughOnException ctx >> if seed == "capture-seed" then pure (Fail err404) else pure (FailFatal err400))
        selected = Choice failed raw
        cases = [(leaf, []), (leaf, [""]), (captured, ["one", "two"]), (raw, ["tail"]), (selected, ["rest"]), (respond "replaced" <$ leaf, [])]
    results <- mapM (\(router, segments) -> do
      result <- runRouterEnv router "capture-seed" segments request context "binding-env"
      case result of
        Route response -> pure response
        _ -> fail "router forwarding failed") cases
    -- Returned bytes remain real responses; convert only the buffered fixture JSON.
    pure (jsonResponse (map (\response -> case responseBody response of
      ResponseBodyLazyBytes bytes -> TextEncoding.decodeUtf8 (LBS.toStrict bytes)
      _ -> error "forwarding fixture must be buffered") results))
  "renderer-rejection" -> serveWithContext
    (Proxy @(Get '[JSON] RejectBody :<|> Get '[JSON] Text)) EmptyContext
    (pure RejectBody :<|> pure "fallback-must-not-run") request context ()
  "named-context-route" -> serveWithContext
    (Proxy @(WithNamedContext "nested" '[Int] ContextValue))
    (NamedContext @"nested" ((40 :: Int) :. EmptyContext) :. EmptyContext)
    (pure 2) request context ()
  "payload-error" -> pure (serverErrorToResponse request err413)
  "media-error" -> pure (serverErrorToResponse request err415)
  "delayed-forwarding" -> runForwardingContracts request >>= pure . jsonResponse
  "capture-metadata" -> do
    let captured = route (Proxy @(Capture "item" Int :> Get '[JSON] Int)) EmptyContext (emptyDelayed (Route pure)) :: Router () ()
        allCaptured = route (Proxy @(CaptureAll "items" Int :> Get '[JSON] [Int])) EmptyContext (emptyDelayed (Route pure)) :: Router () ()
    case (captured, allCaptured) of
      (CaptureRouter [one] _, CaptureAllRouter [many] _) -> pure (jsonResponse
        ( captureName one, captureType one == typeRep (Proxy @Int)
        , captureName many, captureType many == typeRep (Proxy @[Int])
        , one /= many, show [one,many], show one, show many ))
      _ -> fail "capture metadata shape changed"
  "environment-context" -> serveWithContext (Proxy @(CacheControlled '[Public] :> Get '[JSON] Text)) EmptyContext
    (do env <- ask; ctx <- askExecutionContext; liftIO (passThroughOnException ctx); pure env)
    request context ("environment-preserved" :: Text)
  "assets-context" -> serveWithAssets [[]] (error "reserved API must not access assets")
    (Proxy @(Get '[JSON] Text)) EmptyContext
    (do env <- ask; ctx <- askExecutionContext; liftIO (passThroughOnException ctx); pure env)
    request context ("assets-environment" :: Text)
  "long-error" -> pure (serverErrorToResponse request (withDetail (Text.replicate 513 "é") err400))
  "limit-error" -> pure (serverErrorToResponse request (withDetail (Text.replicate 512 "é") err400))
  "named-context-value" -> do
    let nested = NamedContext @"nested" ((42 :: Int) :. EmptyContext) :. EmptyContext
        value = getContextEntry (descendIntoNamedContext (Proxy @"nested") nested :: Context '[Int]) :: Int
    pure (createResponse (Status 200) (Headers.headersFromList [("Content-Type", "application/json")]) (ResponseBodyLazyBytes (encode value)))
  "unicode-headers" -> serveWithContext
    (Proxy @(Get '[JSON] (Headers '[Header "X-Name" Text] Text))) EmptyContext
    (pure (addHeader ("café" :: Text) ("body-é" :: Text))) request context ()
  "stream-context" -> serveWithContext
    (Proxy @(Stream 'GET 206 NoFraming OctetStream (Headers '[Header "X-Environment" Text] ReadableStream))) EmptyContext
    (do env <- ask; ctx <- askExecutionContext; liftIO (passThroughOnException ctx); pure (addHeader env source))
    request context ("stream-env" :: Text)
  "stream-headers" -> serveWithContext
    (Proxy @(Stream 'GET 206 NoFraming OctetStream (Headers '[Header "X-Download" Text, Header "X-Version" Int] ReadableStream)))
    EmptyContext (pure (addHeader ("attachment" :: Text) (addHeader (7 :: Int) source))) request context ()
  "no-content-headers" -> serveWithContext
    (Proxy @(Verb 'GET 200 '[JSON] (Headers '[Header "X-Version" Int] NoContent)))
    EmptyContext (pure (addHeader (7 :: Int) NoContent)) request context ()
  "raw-residual" -> serveWithContext (Proxy @("download" :> Capture "owner" Text :> Raw))
    EmptyContext (\owner remaining _ ctx -> passThroughOnException ctx >> pure (createResponse (Status 200)
      (Headers.headersFromList [("Content-Type", "application/json")])
      (ResponseBodyLazyBytes (encode (owner, remaining))))) request context ()
  _ -> fail "Unknown routing coverage mode"

jsonResponse :: Data.Aeson.ToJSON a => a -> Response
jsonResponse value = createResponse (Status 200) (Headers.headersFromList [("Content-Type", "application/json")]) (ResponseBodyLazyBytes (encode value))

-- A custom public renderer can accept negotiation but refuse a particular body.
data RejectBody = RejectBody
instance {-# OVERLAPPING #-} AllCTRender '[JSON] RejectBody where
  handleAcceptH _ _ _ = Nothing

-- A downstream combinator consumes the context supplied by WithNamedContext.
data ContextValue
instance HasWorkerServer ContextValue '[Int] where
  type ServerT ContextValue m = m Int
  route _ context delayed = route (Proxy @(Get '[JSON] Int)) context
    (fmap (\action -> (+ (getContextEntry context :: Int)) <$> action) delayed)

type ContextMatrix = ("missing" :> ContextValue) :<|>
  ("fixed" :> Capture "first" Int :> CaptureAll "rest" Int
    :> QueryParam "one" Int :> QueryParams "many" Int :> QueryFlag "flag"
    :> Header "X-Value" Int :> ReqBody '[JSON] Int :> EdgeDataCenter
    :> CacheControlled '[Public] :> ContextValue)

data ContextRoutes mode = ContextRoutes { named :: mode :- ContextValue }
  deriving stock Generic

-- Downstream header serialization may supply raw bytes outside UTF-8.
instance {-# OVERLAPPING #-} GetHeaders (Headers '[Header "X-Malformed" Text] Text) where
  getHeaders _ = [("\255", BS.pack [255])]

-- Public content/method extensions use their typed witness at the boundary.
data ContractMime
data ContractMethod
instance Accept ContractMime where
  contentType Proxy = "application" Media.// "x-contract"
instance ReflectMethod ContractMethod where
  reflectMethod Proxy = "GET"
instance {-# OVERLAPPING #-} AllMime '[ContractMime] where
  allMime Proxy = [contentType (Proxy @ContractMime)]
instance {-# OVERLAPPING #-} AllCTRender '[ContractMime] Text where
  handleAcceptH Proxy _ body = Just ("application/x-contract", LBS.fromStrict (TextEncoding.encodeUtf8 body))
instance {-# OVERLAPPING #-} AllCTUnrender '[ContractMime] Text where
  canHandleCTypeH Proxy mime
    | mime == "application/x-contract" = Just (Right . TextEncoding.decodeUtf8 . LBS.toStrict)
    | otherwise = Nothing

roundTripContextRoutes :: ContextRoutes (AsWorker ()) -> ContextRoutes (AsWorker ())
roundTripContextRoutes = to . from

{-# LANGUAGE DataKinds #-}
module Servant.Cloudflare.Workers.CacheControlSpec (spec) where
import Test.Syd hiding (context)
import Data.Proxy
import Data.Text (Text)
import Control.Monad.Reader (ask)
import Servant.Cloudflare.Workers.Handler (askExecutionContext)
import Cloudflare.Workers.Cache (classifyCachePutFailureMessage, CachePutFailureKind(..))
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Servant.API (Raw, Get, PlainText, (:>))
import Servant.Cloudflare.Workers.CacheControl
import Servant.Cloudflare.Workers.Server
import Support.HTTP.Fixtures
spec :: Spec
spec = do
  it "classifies the native non-GET cache rejection without swallowing unrelated failures" $ do
    classifyCachePutFailureMessage "TypeError: Cannot cache response to non-GET request." `shouldBe` CachePutInvalidMethod
    classifyCachePutFailureMessage "unrelated cache operation failed" `shouldBe` CachePutOther
  it "defaults to private caching" $
    cacheControlledHeaderValue (Proxy @'[]) `shouldBe` "private"
  it "renders all durations in canonical order" $
    cacheControlledHeaderValue (Proxy @'[Public, MaxAge 60, SMaxAge 120, StaleWhileRevalidate 30]) `shouldBe` "public, max-age=60, s-maxage=120, stale-while-revalidate=30"
  it "uses the last repeated mode and duration" $
    cacheControlledHeaderValue (Proxy @'[Public, MaxAge 10, Private, MaxAge 20]) `shouldBe` "private, max-age=20"
  it "omits durations for no-store" $
    cacheControlledHeaderValue (Proxy @'[MaxAge 60, NoStore]) `shouldBe` "no-store"
  it "adds cache policy and Vary to a successful raw response" $ do
    response <- serveWithContext (Proxy @(CacheControlled '[Public, MaxAge 60] :> Raw)) EmptyContext
      (\_ _ _ -> pure (Response (Status 200) (headersFromList []) (ResponseBodyBytes "ok"))) request context ()
    headerLookup "Cache-Control" (responseHeaders response) `shouldBe` Just "public, max-age=60"
    headerLookup "Vary" (responseHeaders response) `shouldBe` Just "Accept"
    bodyBytes response `shouldBe` "ok"
  it "marks raw error responses as no-store" $ do
    response <- serveWithContext (Proxy @(CacheControlled '[Public] :> Raw)) EmptyContext
      (\_ _ _ -> pure (Response (Status 400) (headersFromList []) (ResponseBodyBytes "bad"))) request context ()
    headerLookup "Cache-Control" (responseHeaders response) `shouldBe` Just "no-store"
    headerLookup "Vary" (responseHeaders response) `shouldBe` Nothing
  it "preserves an explicitly supplied cache policy" $ do
    response <- serveWithContext (Proxy @(CacheControlled '[Public] :> Raw)) EmptyContext
      (\_ _ _ -> pure (Response (Status 200) (headersFromList [("Cache-Control","no-cache")]) (ResponseBodyBytes "ok"))) request context ()
    headerLookup "Cache-Control" (responseHeaders response) `shouldBe` Just "no-cache"
  it "preserves an explicitly supplied Vary header" $ do
    response <- serveWithContext (Proxy @(CacheControlled '[Public] :> Raw)) EmptyContext
      (\_ _ _ -> pure (Response (Status 200) (headersFromList [("Vary","Origin")]) (ResponseBodyBytes "ok"))) request context ()
    headerLookup "Vary" (responseHeaders response) `shouldBe` Just "Origin"
  it "keeps responses below the error-status boundary cacheable" $ do
    response <- serveWithContext (Proxy @(CacheControlled '[Public] :> Raw)) EmptyContext
      (\_ _ _ -> pure (Response (Status 399) (headersFromList []) (ResponseBodyBytes "redirect"))) request context ()
    headerLookup "Cache-Control" (responseHeaders response) `shouldBe` Just "public"
    headerLookup "Vary" (responseHeaders response) `shouldBe` Just "Accept"
  it "forwards the environment and execution context through the cache combinator" $ do
    response <- serveWithContext (Proxy @(CacheControlled '[Public] :> Get '[PlainText] Text)) EmptyContext
      (askExecutionContext >>= \ctx -> ctx `seq` ask) request context ("binding payload" :: Text)
    bodyBytes response `shouldBe` "binding payload"
    headerLookup "Cache-Control" (responseHeaders response) `shouldBe` Just "public"
  it "passes the request and remaining path to a cached raw handler" $ do
    response <- serveWithContext (Proxy @(CacheControlled '[Public] :> Raw)) EmptyContext
      (\segments req _ -> do
        segments `shouldBe` [""]
        requestMethod req `shouldBe` GET
        pure (Response (Status 200) (headersFromList []) (ResponseBodyBytes "raw"))) request context ()
    bodyBytes response `shouldBe` "raw"

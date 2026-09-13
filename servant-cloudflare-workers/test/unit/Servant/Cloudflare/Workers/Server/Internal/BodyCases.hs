{-# LANGUAGE DataKinds #-}

module Servant.Cloudflare.Workers.Server.Internal.BodyCases (spec) where

import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Cloudflare.Workers.Streaming
import Control.Monad (when)
import Data.IORef
import Data.Proxy
import Data.Text (Text)
import Servant.API hiding (DELETE, GET, HEAD, POST)
import Servant.API qualified as API
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()
import Support.HTTP.Fixtures
import Test.Syd hiding (context)

spec :: Spec
spec = do
    describe "JSON body" $
        mapM_
            ( \(body, code) -> it (show body) $ do
                response <-
                    serveWithContext
                        (Proxy @(ReqBody '[JSON] Text :> Post '[JSON] Text))
                        EmptyContext
                        pure
                        request{requestMethodField = POST, requestHeaders = headersFromList [("Content-Type", "application/json")], requestBodyReaderField = Just (\_ -> pure (Right body))}
                        context
                        ()
                responseStatus response `shouldBe` Status code
                when (code == 200) $ bodyBytes response `shouldBe` body
            )
            [("\"hello\"", 200), ("invalid", 400), ("42", 400), ("", 400)]
    it "rejects incompatible body type before consuming body" $ do
        calls <- newIORef (0 :: Int)
        response <-
            serveWithContext
                (Proxy @(ReqBody '[JSON] Text :> Post '[JSON] Text))
                EmptyContext
                pure
                request{requestMethodField = POST, requestHeaders = headersFromList [("Content-Type", "text/plain")], requestBodyReaderField = Just (\_ -> modifyIORef' calls (+ 1) >> pure (Right "hello"))}
                context
                ()
        responseStatus response `shouldBe` Status 415
        readIORef calls `shouldReturn` 0
    it "propagates body limit failure as 413" $ do
        limits <- newIORef []
        response <-
            serveWithContext
                (Proxy @(ReqBody '[JSON] Text :> Post '[JSON] Text))
                EmptyContext
                pure
                request{requestMethodField = POST, requestHeaders = headersFromList [("Content-Type", "application/json")], requestBodyReaderField = Just (\limit -> modifyIORef' limits (<> [limit]) >> pure (Left ReadableStreamExceededByteLimit))}
                context
                ()
        responseStatus response `shouldBe` Status 413
        readIORef limits `shouldReturn` [1048576]
    it "treats an absent body reader as an empty body" $ do
        response <-
            serveWithContext
                (Proxy @(ReqBody '[PlainText] Text :> Post '[PlainText] Text))
                EmptyContext
                pure
                request{requestMethodField = POST, requestHeaders = headersFromList [("Content-Type", "text/plain;charset=utf-8")]}
                context
                ()
        responseStatus response `shouldBe` Status 200
        bodyBytes response `shouldBe` ""
    it "HEAD on GET preserves content type but emits no body" $ do
        response <- serveWithContext (Proxy @(Get '[JSON] Text)) EmptyContext (pure "hello") request{requestMethodField = HEAD} context ()
        responseStatus response `shouldBe` Status 200
        headerLookup "Content-Type" (responseHeaders response) `shouldBe` Just "application/json;charset=utf-8"
        bodyBytes response `shouldBe` ""
    it "method mismatch includes GET and HEAD in Allow" $ do
        response <- serveWithContext (Proxy @(Get '[JSON] Text)) EmptyContext (pure "hello") request{requestMethodField = DELETE} context ()
        responseStatus response `shouldBe` Status 405
        headerLookup "Allow" (responseHeaders response) `shouldBe` Just "GET, HEAD"
    it "NoContent verb returns 204 without entity headers or body" $ do
        response <- serveWithContext (Proxy @(NoContentVerb 'API.DELETE)) EmptyContext (pure NoContent) request{requestMethodField = DELETE} context ()
        responseStatus response `shouldBe` Status 204
        headerLookup "Content-Type" (responseHeaders response) `shouldBe` Nothing
        bodyBytes response `shouldBe` ""

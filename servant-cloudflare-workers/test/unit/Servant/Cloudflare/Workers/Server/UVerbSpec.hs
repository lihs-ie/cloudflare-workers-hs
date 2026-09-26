{-# LANGUAGE DataKinds #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}

module Servant.Cloudflare.Workers.Server.UVerbSpec (spec) where

import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headerLookup, headerLookupAll, headersFromList)
import Data.IORef (modifyIORef', newIORef, readIORef)
import Data.Proxy (Proxy (Proxy))
import Data.Text (Text)
import Servant.API qualified as API
import Servant.API.ResponseHeaders qualified as ResponseHeaders
import Servant.API.UVerb (UVerb, WithStatus (WithStatus))
import Servant.Cloudflare.Workers.Server (Context (EmptyContext), respond, serveWithContext)
import Support.HTTP.Fixtures (bodyBytes, context, request)
import Test.Syd hiding (context)

spec :: Spec
spec = describe "typed UVerb responses" $ do
    it "decodes non-UTF8 typed header bytes with replacement" $ do
        let value = ResponseHeaders.Headers (WithStatus @200 ("body" :: Text)) (ResponseHeaders.UndecodableHeader "\255" `ResponseHeaders.HCons` ResponseHeaders.HNil) :: API.Headers '[API.Header "X-\255" Text] (WithStatus 200 Text)
        response <-
            serveWithContext
                (Proxy @(UVerb 'API.GET '[API.JSON] '[API.Headers '[API.Header "X-\255" Text] (WithStatus 200 Text)]))
                EmptyContext
                (respond value)
                request
                context
                ()
        headerLookup "X-\xfffd" (responseHeaders response) `shouldBe` Just "\xfffd"
        responseStatus response `shouldBe` Status 200

    it "preserves typed Location on ordinary Verb responses" $ do
        response <-
            serveWithContext
                (Proxy @(API.Verb 'API.POST 201 '[API.JSON] (API.Headers '[API.Header "Location" Text] Text)))
                EmptyContext
                (pure (API.addHeader ("/claims/one" :: Text) ("created" :: Text)))
                request{requestMethodField = POST}
                context
                ()
        responseStatus response `shouldBe` Status 201
        headerLookup "Location" (responseHeaders response) `shouldBe` Just "/claims/one"
        bodyBytes response `shouldBe` "\"created\""

    it "preserves nested duplicate headers in outer-before-inner order" $ do
        let inner = API.addHeader ("inner" :: Text) ("created" :: Text) :: API.Headers '[API.Header "X-Trace" Text] Text
            outer = API.addHeader ("outer" :: Text) (WithStatus @201 inner) :: API.Headers '[API.Header "X-Trace" Text] (WithStatus 201 (API.Headers '[API.Header "X-Trace" Text] Text))
        response <-
            serveWithContext
                (Proxy @(UVerb 'API.POST '[API.JSON] '[API.Headers '[API.Header "X-Trace" Text] (WithStatus 201 (API.Headers '[API.Header "X-Trace" Text] Text))]))
                EmptyContext
                (respond outer)
                request{requestMethodField = POST}
                context
                ()
        headerLookupAll "X-Trace" (responseHeaders response) `shouldBe` ["outer", "inner"]
        responseStatus response `shouldBe` Status 201

    it "selects status 204 and negotiates JSON for bare NoContent" $ do
        response <- serveWithContext (Proxy @(UVerb 'API.GET '[API.JSON] '[API.NoContent])) EmptyContext (respond API.NoContent) request context ()
        responseStatus response `shouldBe` Status 204
        headerLookup "Content-Type" (responseHeaders response) `shouldBe` Just "application/json;charset=utf-8"
        bodyBytes response `shouldBe` ""

    it "uses WithStatus for NoContent without dropping Content-Type" $ do
        response <- serveWithContext (Proxy @(UVerb 'API.GET '[API.JSON] '[WithStatus 202 API.NoContent])) EmptyContext (respond (WithStatus @202 API.NoContent)) request context ()
        responseStatus response `shouldBe` Status 202
        headerLookup "Content-Type" (responseHeaders response) `shouldBe` Just "application/json;charset=utf-8"
        bodyBytes response `shouldBe` ""

    it "rejects an unacceptable representation before handler effects" $ do
        calls <- newIORef (0 :: Int)
        response <-
            serveWithContext
                (Proxy @(UVerb 'API.GET '[API.JSON] '[WithStatus 200 Text]))
                EmptyContext
                (liftIO (modifyIORef' calls (+ 1)) >> respond (WithStatus @200 ("body" :: Text)))
                request{requestHeaders = headersFromList [("Accept", "image/png")]}
                context
                ()
        responseStatus response `shouldBe` Status 406
        readIORef calls `shouldReturn` 0

    it "runs GET for HEAD while retaining status and headers without a body" $ do
        calls <- newIORef (0 :: Int)
        response <-
            serveWithContext
                (Proxy @(UVerb 'API.GET '[API.PlainText] '[WithStatus 201 (API.Headers '[API.Header "Location" Text] Text)]))
                EmptyContext
                (liftIO (modifyIORef' calls (+ 1)) >> respond (WithStatus @201 (API.addHeader ("/result" :: Text) ("body" :: Text)) :: WithStatus 201 (API.Headers '[API.Header "Location" Text] Text)))
                request{requestMethodField = HEAD}
                context
                ()
        responseStatus response `shouldBe` Status 201
        headerLookup "Location" (responseHeaders response) `shouldBe` Just "/result"
        bodyBytes response `shouldBe` ""
        readIORef calls `shouldReturn` 1

    it "places negotiated Content-Type before a supplied Content-Type" $ do
        response <-
            serveWithContext
                (Proxy @(UVerb 'API.POST '[API.JSON] '[API.Headers '[API.Header "Content-Type" Text] (WithStatus 201 Text)]))
                EmptyContext
                (respond (API.addHeader ("custom/type" :: Text) (WithStatus @201 ("created" :: Text)) :: API.Headers '[API.Header "Content-Type" Text] (WithStatus 201 Text)))
                request{requestMethodField = POST}
                context
                ()
        headerLookupAll "Content-Type" (responseHeaders response) `shouldBe` ["application/json;charset=utf-8", "custom/type"]

    it "chooses a declared typed 201 response with Location" $ do
        response <-
            serveWithContext
                (Proxy @(UVerb 'API.POST '[API.JSON] '[WithStatus 201 (API.Headers '[API.Header "Location" Text] Text), WithStatus 200 Int]))
                EmptyContext
                (respond (WithStatus @201 (API.addHeader ("/claims/one" :: Text) ("created" :: Text)) :: WithStatus 201 (API.Headers '[API.Header "Location" Text] Text)))
                request{requestMethodField = POST}
                context
                ()
        responseStatus response `shouldBe` Status 201
        headerLookup "Location" (responseHeaders response) `shouldBe` Just "/claims/one"
        bodyBytes response `shouldBe` "\"created\""

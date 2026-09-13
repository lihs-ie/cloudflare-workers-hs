{-# LANGUAGE DataKinds #-}
module Servant.Cloudflare.Workers.Server.Internal.StreamCases (spec) where

import Test.Syd hiding (context)
import Control.Monad.Except (throwError)
import Data.IORef
import Data.Proxy
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Cloudflare.Workers.Streaming
import Servant.API hiding (GET, POST, DELETE, HEAD)
import Servant.API qualified as API
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Error (err500)
import Support.HTTP.Fixtures

type Download = Stream 'API.GET 206 NoFraming OctetStream ReadableStream

spec :: Spec
spec = describe "native response streaming" $ do
  it "preserves the opaque source, declared status and media type without reading" $ do
    let source = error "stream must remain opaque" :: ReadableStream
    response <- serveWithContext (Proxy @Download) EmptyContext (pure source) request context ()
    responseStatus response `shouldBe` Status 206
    headerLookup "Content-Type" (responseHeaders response) `shouldBe` Just "application/octet-stream"
    case responseBody response of
      ResponseBodyStream _ -> pure ()
      _ -> expectationFailure "expected an unbuffered native stream"
  it "rejects the method before starting the producer" $ do
    started <- newIORef False
    response <- serveWithContext (Proxy @Download) EmptyContext
      (liftIO (writeIORef started True) >> pure (error "stream must remain opaque"))
      request{requestMethodField=POST} context ()
    responseStatus response `shouldBe` Status 405
    headerLookup "Allow" (responseHeaders response) `shouldBe` Just "GET, HEAD"
    readIORef started `shouldReturn` False
  it "rejects unacceptable media before starting the producer" $ do
    started <- newIORef False
    response <- serveWithContext (Proxy @Download) EmptyContext
      (liftIO (writeIORef started True) >> pure (error "stream must remain opaque"))
      request{requestHeaders=headersFromList [("Accept","text/plain")]} context ()
    responseStatus response `shouldBe` Status 406
    readIORef started `shouldReturn` False
  it "accepts an explicit matching media range" $ do
    response <- serveWithContext (Proxy @Download) EmptyContext
      (pure (error "stream must remain opaque"))
      request{requestHeaders=headersFromList [("Accept","application/*")]} context ()
    responseStatus response `shouldBe` Status 206
  it "renders an explicit handler error instead of the declared stream status" $ do
    response <- serveWithContext (Proxy @Download) EmptyContext (throwError err500) request context ()
    responseStatus response `shouldBe` Status 500
    headerLookup "Content-Type" (responseHeaders response) `shouldBe` Just "application/json;charset=utf-8"
    bodyBytes response `shouldBe` "{\"error\":{\"message\":\"Internal Server Error\",\"status\":500}}"

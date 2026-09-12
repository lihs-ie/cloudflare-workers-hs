{-# LANGUAGE DataKinds #-}
module Servant.Cloudflare.Workers.ServerSpec (spec) where
import Test.Syd hiding (context)
import Data.Proxy
import Data.Text (Text)
import Control.Monad.Reader (ask)
import Control.Monad.Except (throwError)
import Cloudflare.Workers.Headers (headersFromList, headerLookup)
import Cloudflare.Workers.Streaming (ReadableStream)
import Servant.API qualified as API
import Servant.Cloudflare.Workers.Handler (Handler, askExecutionContext)
import Servant.Cloudflare.Workers.Server.Internal.Delayed (Delayed, emptyDelayed)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (RouteResult(..))
import Cloudflare.Workers.HTTP
import Servant.API (Get, PlainText)
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()
import Servant.Cloudflare.Workers.Error
import Support.HTTP.Fixtures
type DelayedHandler = Delayed () (Handler () Int)
spec :: Spec
spec = do
  it "finds an entry after a different context type" $
    getContextEntry (True :. (42 :: Int) :. EmptyContext) `shouldBe` (42 :: Int)
  it "chooses the first entry when a type is repeated" $
    getContextEntry ((1 :: Int) :. (2 :: Int) :. EmptyContext) `shouldBe` (1 :: Int)
  it "descends into the selected named context" $ do
    let outer = False :. NamedContext @"nested" ((42 :: Int) :. EmptyContext) :. EmptyContext
    getContextEntry (descendIntoNamedContext (Proxy @"nested") outer :: Context '[Int]) `shouldBe` (42 :: Int)
  it "passes the binding environment to a handler" $ do
    response <- serveWithContext (Proxy @(Get '[PlainText] Text)) EmptyContext ask request context ("from-env" :: Text)
    responseStatus response `shouldBe` Status 200
    bodyBytes response `shouldBe` "from-env"
  it "turns a handler error into its negotiated response" $ do
    response <- serveWithContext (Proxy @(Get '[PlainText] Text)) EmptyContext (throwError err404) request context ()
    responseStatus response `shouldBe` Status 404
  it "returns route errors without invoking the response continuation" $ do
    let respond _ = expectationFailure "unexpected response continuation" >> pure (Fail err500)
    recoverable <- runHandlerAction context () (emptyDelayed (Fail err400) :: DelayedHandler) () request respond
    fatal <- runHandlerAction context () (emptyDelayed (FailFatal err401) :: DelayedHandler) () request respond
    case recoverable of
      Fail e -> e `shouldBe` err400
      _ -> expectationFailure "expected recoverable failure"
    case fatal of
      FailFatal e -> e `shouldBe` err401
      _ -> expectationFailure "expected fatal failure"
  it "negotiates a handler error using request headers" $ do
    response <- serveWithContext (Proxy @(Get '[PlainText] Text)) EmptyContext (throwError err404) request{requestHeaders=headersFromList [("Accept","text/plain")]} context ()
    bodyBytes response `shouldBe` "Not Found"
  it "forwards a usable execution context to the handler" $ do
    response <- serveWithContext (Proxy @(Get '[PlainText] Text)) EmptyContext (askExecutionContext >>= \ctx -> ctx `seq` pure "context available") request context ()
    bodyBytes response `shouldBe` "context available"

  it "renders a typed JSON response body and its response headers" $ do
    response <- serveWithContext
      (Proxy @(API.Get '[API.JSON] (API.Headers '[API.Header "X-Result" Text] Text)))
      EmptyContext (pure (API.addHeader ("created" :: Text) ("payload" :: Text))) request context ()
    responseStatus response `shouldBe` Status 200
    bodyBytes response `shouldBe` "\"payload\""
    headerLookup "Content-Type" (responseHeaders response) `shouldBe` Just "application/json;charset=utf-8"
    headerLookup "X-Result" (responseHeaders response) `shouldBe` Just "created"
  it "renders a typed redirect with NoContent and both headers" $ do
    response <- serveWithContext
      (Proxy @(API.Verb 'API.GET 302 '[API.JSON] (API.Headers '[API.Header "Location" Text, API.Header "Cache-Control" Text] API.NoContent)))
      EmptyContext (pure (API.addHeader ("https://example.com/target" :: Text) (API.addHeader ("no-store" :: Text) API.NoContent))) request context ()
    responseStatus response `shouldBe` Status 302
    bodyBytes response `shouldBe` ""
    headerLookup "Location" (responseHeaders response) `shouldBe` Just "https://example.com/target"
    headerLookup "Cache-Control" (responseHeaders response) `shouldBe` Just "no-store"
    headerLookup "Content-Type" (responseHeaders response) `shouldBe` Nothing
  it "retains typed response headers while suppressing a HEAD response body" $ do
    response <- serveWithContext
      (Proxy @(API.Get '[API.PlainText] (API.Headers '[API.Header "X-Result" Text] Text)))
      EmptyContext (pure (API.addHeader ("present" :: Text) ("hidden" :: Text))) request{requestMethodField=HEAD} context ()
    responseStatus response `shouldBe` Status 200
    bodyBytes response `shouldBe` ""
    headerLookup "X-Result" (responseHeaders response) `shouldBe` Just "present"
  it "preserves Content-Disposition on a typed native stream without consuming it" $ do
    response <- serveWithContext
      (Proxy @(API.Stream 'API.GET 200 API.NoFraming API.OctetStream (API.Headers '[API.Header "Content-Disposition" Text] ReadableStream)))
      EmptyContext (pure (API.addHeader ("attachment; filename=report.csv" :: Text) (error "stream must remain opaque" :: ReadableStream))) request context ()
    responseStatus response `shouldBe` Status 200
    headerLookup "Content-Disposition" (responseHeaders response) `shouldBe` Just "attachment; filename=report.csv"
    case responseBody response of
      ResponseBodyStream _ -> pure ()
      _ -> expectationFailure "stream response was buffered"

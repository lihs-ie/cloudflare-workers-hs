{-# LANGUAGE DataKinds #-}
module Servant.Cloudflare.Workers.AssetsSpec (spec) where

import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.HTTP
import Control.Monad.Except (throwError)
import Data.Proxy
import Data.Text (Text)
import Servant.API (Get, JSON, (:>))
import Servant.Cloudflare.Workers.Assets
import Servant.Cloudflare.Workers.Error
import Servant.Cloudflare.Workers.Server
import Support.HTTP.Fixtures (bodyBytes, context)
import Support.Server.Requests (atPath)
import Test.Syd hiding (context)

type API = "api" :> "health" :> Get '[JSON] Text

spec :: Spec
spec = describe "API namespace isolation from assets" $ do
    it "preserves a successful API response without evaluating Assets" $ do
        response <- run (pure "ok") (atPath "https://example.com/api/health?x=1")
        bodyBytes response `shouldBe` "\"ok\""
    it "reserves decoded path segments with the same rules as the router" $ do
        response <- run (pure "ok") (atPath "https://example.com/%61pi/health")
        responseStatus response `shouldBe` Status 200
    it "preserves unknown API routes as 404" $ do
        response <- run (pure "ok") (atPath "https://example.com/api/missing")
        responseStatus response `shouldBe` Status 404
    it "preserves method rejection as 405" $ do
        response <- run (pure "ok") (atPath "https://example.com/api/health"){requestMethodField = POST}
        responseStatus response `shouldBe` Status 405
    it "preserves content negotiation rejection as 406" $ do
        response <- run (pure "ok") (atPath "https://example.com/api/health"){requestHeaders = headersFromList [("Accept", "text/plain")]}
        responseStatus response `shouldBe` Status 406
    it "preserves an application authentication rejection" $ do
        response <- run (throwError err401) (atPath "https://example.com/api/health")
        responseStatus response `shouldBe` Status 401
  where
    run server request = serveWithAssets [["api"]] (error "API must not access assets") (Proxy @API) EmptyContext server request context ()

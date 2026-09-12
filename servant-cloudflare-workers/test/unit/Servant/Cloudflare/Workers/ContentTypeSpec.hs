{-# LANGUAGE DataKinds #-}
{-# LANGUAGE OverloadedStrings #-}
module Servant.Cloudflare.Workers.ContentTypeSpec (spec) where
import Test.Syd hiding (context)
import Cloudflare.Workers.HTTP (Request(..))
import Cloudflare.Workers.Headers (headersFromList)
import Data.Proxy (Proxy(..))
import Servant.API (JSON)
import Servant.Cloudflare.Workers.ContentType
import Servant.Cloudflare.Workers.Error (err406)
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (runDelayedIO)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (RouteResult(..))
import Support.HTTP.Fixtures (request)
spec :: Spec
spec = do
  it "defaults missing content type to application/octet-stream" $
    getContentTypeHeader request `shouldBe` "application/octet-stream"
  it "preserves explicit content type and charset" $
    getContentTypeHeader request{requestHeaders = headersFromList [("content-type", "text/plain;charset=utf-8")]} `shouldBe` "text/plain;charset=utf-8"
  it "accepts JSON when Accept is missing" $
    runDelayedIO (acceptCheck (Proxy @'[JSON]) (getAcceptHeader request)) request `shouldReturn` Route ()
  it "rejects incompatible Accept as recoverable 406" $
    runDelayedIO (acceptCheck (Proxy @'[JSON]) (AcceptHeader "image/png")) request `shouldReturn` Fail err406

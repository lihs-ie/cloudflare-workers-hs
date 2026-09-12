{-# LANGUAGE DataKinds #-}
module Servant.Cloudflare.Workers.EdgeDataCenterSpec (spec) where
import Test.Syd hiding (context)
import Data.Text (Text)
import Data.Proxy
import Servant.API
import Cloudflare.Workers.HTTP
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()
import Servant.Cloudflare.Workers.EdgeDataCenter
import Support.HTTP.Fixtures
spec :: Spec
spec = do
  it "passes the absent edge location to the handler" $ do
    response <- serveWithContext (Proxy @(EdgeDataCenter :> Get '[JSON] (Maybe Text))) EmptyContext pure request context ()
    bodyBytes response `shouldBe` "null"
  it "passes the exact edge location to the handler" $ do
    response <- serveWithContext (Proxy @(EdgeDataCenter :> Get '[JSON] (Maybe Text))) EmptyContext pure request{requestDataCenterField=Just "NRT"} context ()
    bodyBytes response `shouldBe` "\"NRT\""

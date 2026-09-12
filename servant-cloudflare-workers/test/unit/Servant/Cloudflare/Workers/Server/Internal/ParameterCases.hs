{-# LANGUAGE DataKinds #-}
module Servant.Cloudflare.Workers.Server.Internal.ParameterCases (spec) where
import Test.Syd hiding (context)
import Data.Proxy
import Data.Text (Text)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Servant.API
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal (EmptyServer(..))
import Support.HTTP.Fixtures
import Support.Server.Requests
spec :: Spec
spec = do
  describe "QueryParam" $ mapM_ (\(path,code,body) -> it (show path) $ do
    response <- serveWithContext (Proxy @(QueryParam "value" Int :> Get '[JSON] (Maybe Int))) EmptyContext pure (atPath path) context ()
    responseStatus response `shouldBe` Status code
    if code == 200 then bodyBytes response `shouldBe` body else pure ())
    [("/?value=42",200,"42"),("/",200,"null"),("/?value",200,"null"),("/?value=nope",400,"")]
  describe "QueryParams" $ mapM_ (\(path,code,body) -> it (show path) $ do
    response <- serveWithContext (Proxy @(QueryParams "value" Int :> Get '[JSON] [Int])) EmptyContext pure (atPath path) context ()
    responseStatus response `shouldBe` Status code
    if code == 200 then bodyBytes response `shouldBe` body else pure ())
    [("/?value=1&value[]=2&other=3",200,"[1,2]"),("/?value&other=3",200,"[]"),("/?value=nope",400,"")]
  describe "QueryFlag" $ mapM_ (\(path,body) -> it (show path) $ do
    response <- serveWithContext (Proxy @(QueryFlag "enabled" :> Get '[JSON] Bool)) EmptyContext pure (atPath path) context ()
    bodyBytes response `shouldBe` body)
    [("/","false"),("/?enabled","true"),("/?enabled=true","true"),("/?enabled=1","true"),("/?enabled=","true"),("/?enabled=false","false")]
  describe "Header" $ mapM_ (\(headers,code,body) -> it (show headers) $ do
    response <- serveWithContext (Proxy @(Header "X-Value" Int :> Get '[JSON] (Maybe Int))) EmptyContext pure request{requestHeaders=headersFromList headers} context ()
    responseStatus response `shouldBe` Status code
    if code == 200 then bodyBytes response `shouldBe` body else pure ())
    [([],200,"null"),([("x-value","12")],200,"12"),([("X-Value","nope")],400,"")]
  describe "Capture" $ mapM_ (\(path,code,body) -> it (show path) $ do
    response <- serveWithContext (Proxy @(Capture "value" Int :> Get '[JSON] Int)) EmptyContext pure (atPath path) context ()
    responseStatus response `shouldBe` Status code
    if code == 200 then bodyBytes response `shouldBe` body else pure ())
    [("/12",200,"12"),("/nope",400,""),("/",404,"")]
  it "CaptureAll preserves decoded segments" $ do
    response <- serveWithContext (Proxy @(CaptureAll "values" Text :> Get '[JSON] [Text])) EmptyContext pure (atPath "/one/two%2Fthree") context ()
    bodyBytes response `shouldBe` "[\"one\",\"two/three\"]"
  it "CaptureAll rejects malformed typed segments" $ do
    response <- serveWithContext (Proxy @(CaptureAll "values" Int :> Get '[JSON] [Int])) EmptyContext pure (atPath "/1/nope") context ()
    responseStatus response `shouldBe` Status 400
  it "EmptyAPI rejects all requests" $ do
    response <- serveWithContext (Proxy @EmptyAPI) EmptyContext EmptyServer request context ()
    responseStatus response `shouldBe` Status 404
  it "EmptyAPI prefix leaves the nested API reachable" $ do
    response <- serveWithContext (Proxy @(EmptyAPI :> Get '[JSON] Int)) EmptyContext (pure 42) request context ()
    bodyBytes response `shouldBe` "42"
  it "WithNamedContext dispatches the nested API" $ do
    response <- serveWithContext (Proxy @(WithNamedContext "nested" '[Int] (Get '[JSON] Int)))
      (NamedContext @"nested" ((42::Int) :. EmptyContext) :. EmptyContext) (pure 42) request context ()
    bodyBytes response `shouldBe` "42"

module Servant.Cloudflare.Workers.Server.Internal.DelayedIOSpec (spec) where
import Test.Syd hiding (context)
import Cloudflare.Workers.HTTP (requestMethod, Method(GET))
import Servant.Cloudflare.Workers.Error
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO
import Servant.Cloudflare.Workers.Server.Internal.RouteResult
import Support.HTTP.Fixtures (request)
spec :: Spec
spec = do
  it "provides the current request" $
    runDelayedIO (withRequest (pure . requestMethod)) request `shouldReturn` Route GET
  it "lifts success" $
    runDelayedIO (liftRouteResult (Route (42::Int))) request `shouldReturn` Route 42
  it "distinguishes recoverable failure" $
    runDelayedIO (delayedFail err404 :: DelayedIO ()) request `shouldReturn` Fail err404
  it "distinguishes fatal failure" $
    runDelayedIO (delayedFailFatal err400 :: DelayedIO ()) request `shouldReturn` FailFatal err400

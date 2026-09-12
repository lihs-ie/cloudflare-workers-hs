{-# LANGUAGE OverloadedStrings #-}
module Support.Router.Applications (failure, success, run) where
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Servant.Cloudflare.Workers.Error
import Servant.Cloudflare.Workers.Server.Internal.Router
import Servant.Cloudflare.Workers.Server.Internal.RouteResult
import Support.HTTP.Fixtures
failure :: ServerError -> RoutingApplication ()
failure e _ _ _ _ = pure (Fail e)
success :: RoutingApplication ()
success _ _ _ _ = pure (Route (createResponse (Status 200) (headersFromList []) (ResponseBodyLazyBytes "ok")))
run :: [RoutingApplication ()] -> IO (Either ServerError Int)
run apps = do
  result <- runChoice apps [] request context ()
  pure $ case result of
    Fail e -> Left e
    FailFatal e -> Left e
    Route response -> Right (statusCode (responseStatus response))

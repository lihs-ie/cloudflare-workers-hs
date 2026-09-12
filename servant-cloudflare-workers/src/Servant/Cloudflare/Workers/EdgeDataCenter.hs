module Servant.Cloudflare.Workers.EdgeDataCenter (
    EdgeDataCenter,
) where

import Cloudflare.Workers.HTTP (requestDataCenter)
import Data.Proxy (Proxy (Proxy))
import Data.Text (Text)
import Servant.API ((:>))
import Servant.Cloudflare.Workers.Handler (Handler)
import Servant.Cloudflare.Workers.Server (Context, HasWorkerServer (ServerT, route))
import Servant.Cloudflare.Workers.Server.Internal.Delayed (Delayed, passToServer)
import Servant.Cloudflare.Workers.Server.Internal.Router (Router)

data EdgeDataCenter

instance (HasWorkerServer api context) => HasWorkerServer (EdgeDataCenter :> api) context where
    type ServerT (EdgeDataCenter :> api) m = Maybe Text -> ServerT api m

    route ::
        forall captureEnv bindingEnv.
        Proxy (EdgeDataCenter :> api) ->
        Context context ->
        Delayed captureEnv (Maybe Text -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (passToServer delayedServer requestDataCenter)

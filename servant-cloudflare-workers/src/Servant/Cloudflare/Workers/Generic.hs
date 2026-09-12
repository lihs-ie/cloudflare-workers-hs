{-# LANGUAGE ScopedTypeVariables #-}

module Servant.Cloudflare.Workers.Generic (
    AsWorker,
    AsWorkerT,
    genericServeWithContext,
) where

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Data.Kind (Type)
import Data.Proxy (Proxy (Proxy))
import Servant.API (NamedRoutes)
import Servant.Cloudflare.Workers.Handler (Handler)
import Servant.Cloudflare.Workers.Server (Context, HasWorkerServer, serveWithContext)
import Servant.Cloudflare.Workers.Server.Internal (AsWorkerT)

type AsWorker (env :: Type) = AsWorkerT (Handler env)

genericServeWithContext ::
    forall routes context env.
    (HasWorkerServer (NamedRoutes routes) context) =>
    Context context ->
    routes (AsWorker env) ->
    Request ->
    WorkersExecutionContext ->
    env ->
    IO Response
genericServeWithContext = serveWithContext (Proxy :: Proxy (NamedRoutes routes))

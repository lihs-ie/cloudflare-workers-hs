module Servant.Cloudflare.Workers.Server (
    ServerContext (..),
    Server,
    HasWorkerServer (..),
) where

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Reactor (Context)
import Data.Data (Proxy)
import Data.Kind (Type)
import Servant.Cloudflare.Workers.Handler (Handler)

data ServerContext (context :: [Type]) where
    EmptyServerContext :: ServerContext '[]
    (:.) :: x -> ServerContext xs -> ServerContext (x ': xs)

infixr 5 :.

class HasWorkerServer api where
    type ServerT api (m :: Type -> Type) :: Type

    serveWithContext ::
        Proxy api ->
        ServerContext context ->
        ServerT api (Handler env) ->
        Request ->
        Context ->
        env ->
        IO Response

type Server api env = ServerT api (Handler env)

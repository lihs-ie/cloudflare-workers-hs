{- |
The server interpreter class follows @servant-server-0.20.3.0@'s
@Servant.Server.Internal.HasServer@ contract.

Copyright (c) 2014-2016, Zalora South East Asia Pte Ltd,
2016-2018 Servant Contributors. Distributed under BSD-3-Clause.
This Workers port substitutes its own handler, context, and router types.
-}
module Servant.Cloudflare.Workers.Server.Internal.HasWorkerServer (
    HasWorkerServer (..),
    Server,
) where

import Data.Kind (Type)
import Data.Proxy (Proxy)
import Servant.Cloudflare.Workers.Handler (Handler)
import Servant.Cloudflare.Workers.Server.Internal.Context (Context)
import Servant.Cloudflare.Workers.Server.Internal.Delayed (Delayed)
import Servant.Cloudflare.Workers.Server.Internal.Router (Router)

class HasWorkerServer api context where
    type ServerT api (m :: Type -> Type) :: Type

    route ::
        Proxy api ->
        Context context ->
        Delayed captureEnv (ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv

type Server api env = ServerT api (Handler env)

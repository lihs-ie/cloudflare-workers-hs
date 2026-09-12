module Minimal.Application (server) where

import Minimal.API
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Server.Internal ()

server :: Server API ()
server = Routes { health = pure (Health "ok") }

module StaticAssets.Application (server) where

import Data.Aeson (object, (.=))
import Data.Text (Text)
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Server.Internal ()
import StaticAssets.API

server :: Server API env
server = Routes
    { health = pure (object ["status" .= ("ok" :: Text), "runtime" .= ("Haskell/WASM" :: Text)])
    }

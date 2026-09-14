module StaticAssets.Application (server) where

import Data.Aeson (object, (.=))
import Data.Text (Text)
import Servant.Cloudflare.Workers.Server (Server)
import StaticAssets.API

server :: Server API env
server = Routes
    { health = pure (object ["status" .= ("ok" :: Text), "runtime" .= ("Haskell/WASM" :: Text)])
    }

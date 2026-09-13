module StaticAssets.API (API, Routes(..)) where

import Data.Aeson (Value)
import GHC.Generics (Generic)
import Servant.API

data Routes mode = Routes
    { health :: mode :- "api" :> "health" :> Get '[JSON] Value
    } deriving stock (Generic)

type API = NamedRoutes Routes

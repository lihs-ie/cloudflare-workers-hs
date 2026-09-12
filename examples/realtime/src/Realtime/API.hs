module Realtime.API (API, Routes(..), RoomAPI, RoomRoutes(..)) where
import Data.Aeson (Value)
import Data.Text (Text)
import GHC.Generics (Generic)
import Servant.API
import Servant.API.Generic ((:-))
data Routes mode = Routes
  { health :: mode :- "health" :> Get '[JSON] Value
  , createRoom :: mode :- "rooms" :> Post '[JSON] Value
  , roomByIdentifier :: mode :- "room-identifiers" :> Capture "identifier" Text :> Raw
  , room :: mode :- "rooms" :> Capture "room" Text :> Raw
  } deriving stock (Generic)
type API = NamedRoutes Routes
data RoomRoutes mode = RoomRoutes
  { connect :: mode :- "connect" :> Raw
  , monitor :: mode :- "monitor" :> Raw
  , history :: mode :- "history" :> Get '[JSON] Value
  , autoResponse :: mode :- "auto-response" :> ReqBody '[JSON] Bool :> Put '[JSON] Value
  , allConnections :: mode :- "all-connections" :> Get '[JSON] Value
  , connections :: mode :- "connections" :> Get '[JSON] Value
  } deriving stock (Generic)
type RoomAPI = NamedRoutes RoomRoutes

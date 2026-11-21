module QueuedJobs.API (API, Routes(..)) where

import Data.Aeson (Value)
import Data.Text (Text)
import GHC.Generics (Generic)
import QueuedJobs.QueueExamples (QueueRoutes)
import Servant.API
import Servant.API.Generic ((:-))

data Routes mode = Routes
    { health :: mode :- "health" :> Get '[JSON] Value
    , queueExamples :: mode :- "queue-examples" :> NamedRoutes QueueRoutes
    , submitJobs :: mode :- "jobs" :> ReqBody '[JSON] Value :> Post '[JSON] Value
    , jobSettings :: mode :- "jobs" :> "settings" :> ReqBody '[JSON] Value :> Post '[JSON] Value
    , jobHistory :: mode :- "jobs" :> "settings" :> "history" :> Get '[JSON] Value
    , jobStatus :: mode :- "jobs" :> Capture "identifier" Text :> Get '[JSON] Value
    }
    deriving stock (Generic)

type API = NamedRoutes Routes

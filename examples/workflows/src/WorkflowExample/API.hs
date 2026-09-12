module WorkflowExample.API where
import Data.Aeson (Value)
import Data.Text (Text)
import GHC.Generics (Generic)
import Servant.API
import Servant.API.Generic ((:-))
import WorkflowExample.Domain

data Routes mode = Routes
    { health :: mode :- "health" :> Get '[JSON] Value
    , create :: mode :- "workflows" :> ReqBody '[JSON] CreateRequest :> Post '[JSON] Value
    , createGenerated :: mode :- "workflows" :> "generated" :> ReqBody '[JSON] ApprovalRequest :> Post '[JSON] Value
    , status :: mode :- "workflows" :> Capture "instance" Text :> Get '[JSON] Value
    , approve :: mode :- "workflows" :> Capture "instance" Text :> "approve" :> ReqBody '[JSON] Approval :> Post '[JSON] Value
    , control :: mode :- "workflows" :> Capture "instance" Text :> "control" :> ReqBody '[JSON] Text :> Post '[JSON] Value
    , audit :: mode :- "workflows" :> Capture "instance" Text :> "audit" :> Get '[JSON] Value
    } deriving stock (Generic)
type API = NamedRoutes Routes

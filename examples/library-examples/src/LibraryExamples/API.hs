module LibraryExamples.API (API, Routes(..), GuideAPI, GuideRoutes(..)) where
import Servant.Cloudflare.Workers.CacheControl qualified as Cache
import Servant.Cloudflare.Workers.EdgeDataCenter (EdgeDataCenter)
import LibraryExamples.QueueExamples (QueueRoutes)
import LibraryExamples.Archives (ArchiveAPI)
import LibraryExamples.Client (ClientTargetAPI)
import Data.Aeson (Value)
import Data.Text (Text)
import GHC.Generics (Generic)
import Servant.API
import Servant.API.Generic ((:-))

data Routes mode = Routes
    { archives :: mode :- "archives" :> ArchiveAPI
    , health :: mode :- "health" :> Get '[JSON] Value
    , echo :: mode :- "echo" :> ReqBody '[JSON] Text :> Post '[JSON] Text
    , conflict :: mode :- "conflict" :> Get '[JSON] Value
    , writeSettings :: mode :- "settings" :> Post '[JSON] Value
    , readGuide :: mode :- "guide" :> Cache.CacheControlled '[ 'Cache.Public, 'Cache.MaxAge 60] :> Get '[JSON] Value
    , deleteGuide :: mode :- "guide" :> Delete '[JSON] Value
    , serviceRequest :: mode :- "service" :> Get '[JSON] Value
    , streamRequest :: mode :- "stream" :> Get '[JSON] Value
    , loggingPolicy :: mode :- "logging" :> Capture "policy" Text :> Post '[JSON] Value
    , configuration :: mode :- "configuration" :> Get '[JSON] Value
    , databaseCatalog :: mode :- "database" :> "catalog" :> Post '[JSON] Value
    , storageRequest :: mode :- "storage" :> Capture "scenario" Text :> Post '[JSON] Value
    , clientPolicy :: mode :- "client-policy" :> Get '[JSON] Value
    , clientTarget :: mode :- "client-target" :> ClientTargetAPI
    , tlsRequest :: mode :- "tls" :> Get '[JSON] Value
    , startTlsRequest :: mode :- "starttls" :> Get '[JSON] Value
    , r2Scenario :: mode :- "r2" :> Capture "scenario" Text :> Post '[JSON] Value
    , edgeInfo :: mode :- "diagnostics" :> "edge" :> Cache.CacheControlled '[ 'Cache.NoStore] :> EdgeDataCenter :> Get '[JSON] Value
    , clientStream :: mode :- "client-stream" :> Get '[JSON] Value
    , clientOptions :: mode :- "client-options" :> QueryParam "timeout" Int :> QueryParam "retries" Int :> QueryParam "delay" Int :> QueryParam "mode" Text :> Get '[JSON] Value
    , attachments :: mode :- "attachments" :> Raw
    , queueExamples :: mode :- "queue-examples" :> NamedRoutes QueueRoutes
    , submitJobs :: mode :- "jobs" :> ReqBody '[JSON] Value :> Post '[JSON] Value
    , jobSettings :: mode :- "jobs" :> "settings" :> ReqBody '[JSON] Value :> Post '[JSON] Value
    , jobHistory :: mode :- "jobs" :> "settings" :> "history" :> Get '[JSON] Value
    , jobStatus :: mode :- "jobs" :> Capture "identifier" Text :> Get '[JSON] Value
    , tcpStructuredRequest :: mode :- "tcp-structured" :> Get '[JSON] Value
    , tcpRequest :: mode :- "tcp" :> Get '[JSON] Value
    }
    deriving stock (Generic)

type API = NamedRoutes Routes

data GuideRoutes mode = GuideRoutes
    { guideHealth :: mode :- "health" :> Get '[JSON] Value
    , guideEcho :: mode :- "echo" :> ReqBody '[JSON] Text :> Post '[JSON] Text
    , guideConflict :: mode :- "conflict" :> Get '[JSON] Value
    }
    deriving stock (Generic)

type GuideAPI = NamedRoutes GuideRoutes

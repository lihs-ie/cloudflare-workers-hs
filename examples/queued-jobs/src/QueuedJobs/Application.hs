module QueuedJobs.Application (server, protectFailures) where

import Cloudflare.Workers.Binding.D1 (D1)
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace)
import Cloudflare.Workers.Binding.KV (KV)
import Cloudflare.Workers.Binding.Queue (QueueProducer)
import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding)
import Cloudflare.Workers.HTTP (createResponse, Status(..), ResponseBody(..))
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Middleware (Middleware)
import Control.Exception (SomeException, catch)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (object, (.=))
import Data.Text (Text)
import QueuedJobs.API (API, Routes(..))
import QueuedJobs.Jobs qualified as Jobs
import QueuedJobs.QueueExamples (queueExampleServer)
import Servant.Cloudflare.Workers.Error qualified as Errors
import Servant.Cloudflare.Workers.Error (ServerError(..))
import Servant.Cloudflare.Workers.ErrorMapping (mapExceptionsToServerError)
import Servant.Cloudflare.Workers.Server (Server)

server :: D1 -> ServiceBinding -> QueueProducer -> DurableObjectNamespace -> KV -> Server API env
server database validator producer namespace kv = Routes
    { health = pure (object ["status" .= ("ok" :: Text)])
    , queueExamples = queueExampleServer producer kv
    , submitJobs = mapped . Jobs.submitJobs database validator producer
    , jobSettings = mapped . Jobs.updateJobSettings namespace
    , jobHistory = mapped (Jobs.readSettingsHistory namespace)
    , jobStatus = mapped . Jobs.readJobState namespace
    }

mapped action = mapExceptionsToServerError (\case
  Jobs.JobInput -> Errors.err400
  Jobs.JobMissing -> Errors.err404
  Jobs.JobConflict -> ServerError 409 "Conflict" [] Nothing) (liftIO action)

protectFailures :: Middleware env
protectFailures handler request env context =
    handler request env context `catch` \(_ :: SomeException) ->
        pure (createResponse (Status 500) (headersFromList [("content-type", "application/json")])
            (ResponseBodyBytes "{\"error\":\"internal_error\"}"))

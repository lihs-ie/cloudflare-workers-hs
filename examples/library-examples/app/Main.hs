{-# LANGUAGE CPP #-}
module Main (main) where
#ifdef WASM_COVERAGE
import Trace.Hpc.Reflect (examineTix)
import Data.Text qualified as CoverageText
#endif
import Cloudflare.Workers.Binding.R2 (R2Bucket(..))
import Cloudflare.Workers.Binding.KV (KV(..))
import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding(..))
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Entrypoint.Tail
import Cloudflare.Workers.Env (BindingEnv, getDurableObjectNamespace)
import Cloudflare.Workers.Entrypoint.Queue (QueueRetryOptions(..))
import Cloudflare.Workers.Entrypoint.Queue.Typed (createJSONQueueHandlerWith, QueueFailureDisposition(..))
import Cloudflare.Workers.Observability (tailLog)
import Cloudflare.Workers.Socket
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Data.Text.Encoding (decodeUtf8)
import Data.Proxy (Proxy(..))
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)
import Cloudflare.Workers.Binding.D1 (D1(..))
import Cloudflare.Workers.Binding.Queue (QueueProducer(..))
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace(..), DurableObjectStorage(..))
import Cloudflare.Workers.Binding.Secret (Secret(..))
import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import LibraryExamples.Jobs qualified as Jobs
import Data.Aeson (eitherDecodeStrict', toJSON)
import Data.Text.Encoding (encodeUtf8)
import Control.Exception (throwIO)
import Servant.Client.Core (parseBaseUrl)
import LibraryExamples.Configuration qualified as Configuration
import LibraryExamples.SocketExamples (socketEndpoints)
import LibraryExamples.API (API)
import LibraryExamples.Application (server)
import Servant.Cloudflare.Workers.Server (serveWithContext, Context(..))

main :: IO ()
main = pure ()

fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
fetch request env context = do
  endpoints <- socketEndpoints env
  bucket <- R2Bucket <$> exampleBucket env
  kv <- KV <$> settingsBinding env
  service <- ServiceBinding <$> guideBinding env
  connector <- SocketConnector <$> socketConnector env
  database <- D1 <$> jobsDatabase env
  validator <- ServiceBinding <$> jobsValidator env
  producer <- QueueProducer <$> jobsProducer env
  namespace <- DurableObjectNamespace <$> jobsNamespace env
  secretText <- attachmentKey env >>= jsValToText
  origin <- clientOrigin env >>= jsValToText
  clientBase <- parseBaseUrl (Text.unpack origin)
  let secret = if Text.null secretText then Nothing else Just (Secret secretText)
  createFetchHandler
    (Configuration.instrumented (\req (bindings :: Configuration.ConfigurationBindings) ctx -> serveWithContext (Proxy @API) EmptyContext (server database validator producer namespace secret clientBase kv service connector bucket endpoints (Configuration.settingsFromBindings bindings)) req ctx ()))
    request env context
foreign export javascript "fetch" fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "$1.EXAMPLE_BUCKET" exampleBucket :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.SETTINGS" settingsBinding :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.GUIDE" guideBinding :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.SOCKET_CONNECT" socketConnector :: JSVal -> IO JSVal

tailEvents :: JSVal -> JSVal -> JSVal -> IO ()
tailEvents = createTailHandler (\events (_ :: BindingEnv '[] '[] '[]) _ ->
  mapM_ (\event -> tailLog ("tail outcome=" <> tailEventOutcome event <> " script=" <> maybe "unknown" id (tailEventScriptName event) <> " timestamp=" <> Text.pack (show (tailEventEventTimestamp event)))) events)
foreign export javascript "tail" tailEvents :: JSVal -> JSVal -> JSVal -> IO ()


foreign import javascript unsafe "$1.JOBS_DB" jobsDatabase :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.JOBS_VALIDATOR" jobsValidator :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.JOBS_QUEUE" jobsProducer :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.JOBS_STATE" jobsNamespace :: JSVal -> IO JSVal
foreign import javascript unsafe "typeof $1.ATTACHMENT_SSEC_KEY === 'string' ? $1.ATTACHMENT_SSEC_KEY : ''" attachmentKey :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.CLIENT_ORIGIN || 'http://127.0.0.1:1'" clientOrigin :: JSVal -> IO JSVal

jobsInitialize :: JSVal -> IO ()
jobsInitialize storage = Jobs.initializeJobs (DurableObjectStorage storage)
foreign export javascript "jobsInitialize" jobsInitialize :: JSVal -> IO ()
jobsCommit :: JSVal -> JSVal -> IO JSVal
jobsCommit storage input = jsValToText input >>= Jobs.commitJob (DurableObjectStorage storage) >>= textToJSVal
foreign export javascript "jobsCommit" jobsCommit :: JSVal -> JSVal -> IO JSVal
jobsStatus :: JSVal -> JSVal -> IO JSVal
jobsStatus storage input = jsValToText input >>= Jobs.jobState (DurableObjectStorage storage) >>= textToJSVal
foreign export javascript "jobsStatus" jobsStatus :: JSVal -> JSVal -> IO JSVal
jobsSaveSettings :: JSVal -> JSVal -> IO JSVal
jobsSaveSettings storage input = jsValToText input >>= Jobs.saveSettings (DurableObjectStorage storage) >>= textToJSVal
foreign export javascript "jobsSaveSettings" jobsSaveSettings :: JSVal -> JSVal -> IO JSVal
jobsSettingsHistory :: JSVal -> IO JSVal
jobsSettingsHistory storage = Jobs.settingsHistory (DurableObjectStorage storage) >>= textToJSVal
foreign export javascript "jobsSettingsHistory" jobsSettingsHistory :: JSVal -> IO JSVal
processJob :: JSVal -> JSVal -> IO ()
processJob env input = do
  namespace <- DurableObjectNamespace <$> jobsNamespace env
  text <- jsValToText input
  body <- either (const (throwIO Jobs.JobInput)) pure (eitherDecodeStrict' (encodeUtf8 text))
  Jobs.processJob namespace body
foreign export javascript "processJob" processJob :: JSVal -> JSVal -> IO ()

-- The typed helper isolates poison messages and settles only after DO commit.
jobsQueue :: JSVal -> JSVal -> JSVal -> IO ()
jobsQueue = createJSONQueueHandlerWith
  (\_ _ _ _ -> pure (RetryMessage (QueueRetryOptions (Just 1))))
  (\_ (job :: Jobs.Job) (env :: BindingEnv '[] '["JOBS_STATE"] '[]) _ ->
    Jobs.processJob (getDurableObjectNamespace (Proxy @"JOBS_STATE") env) (toJSON job))
foreign export javascript "queue" jobsQueue :: JSVal -> JSVal -> JSVal -> IO ()

#ifdef WASM_COVERAGE
coverage :: IO JSVal
coverage = examineTix >>= textToJSVal . CoverageText.pack . show
foreign export javascript "coverage" coverage :: IO JSVal
#endif

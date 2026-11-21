{-# LANGUAGE CPP #-}
module Main (main) where

import Cloudflare.Workers.Binding.D1 (D1(..))
import Cloudflare.Workers.Binding.KV (KV(..))
import Cloudflare.Workers.Binding.Queue (QueueProducer(..))
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace(..), DurableObjectStorage(..))
import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding(..))
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Entrypoint.Queue (QueueRetryOptions(..))
import Cloudflare.Workers.Entrypoint.Queue.Typed (createJSONQueueHandlerWith, QueueFailureDisposition(..))
import Cloudflare.Workers.Env (BindingEnv, getDurableObjectNamespace)
import Control.Exception (throwIO)
import Data.Aeson (eitherDecodeStrict', toJSON)
import Data.Proxy (Proxy(..))
import Data.Text.Encoding (encodeUtf8)
import QueuedJobs.API (API)
import QueuedJobs.Application (server, protectFailures)
import QueuedJobs.Jobs qualified as Jobs
import GHC.Wasm.Prim (JSVal)
import Servant.Cloudflare.Workers.Server (serveWithContext, Context(..))
import WorkersSupport.Interop (jsValToText, textToJSVal)
#ifdef WASM_COVERAGE
import Trace.Hpc.Reflect (examineTix)
import Data.Text qualified as CoverageText
#endif

main :: IO ()
main = pure ()

fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
fetch request env context = do
    database <- D1 <$> jobsDatabase env
    validator <- ServiceBinding <$> jobsValidator env
    producer <- QueueProducer <$> jobsProducer env
    namespace <- DurableObjectNamespace <$> jobsNamespace env
    kv <- KV <$> settingsBinding env
    createFetchHandler (protectFailures (\req (_ :: BindingEnv '[] '[] '[]) ctx -> serveWithContext (Proxy @API) EmptyContext (server database validator producer namespace kv) req ctx ())) request env context
foreign export javascript "fetch" fetch :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.JOBS_DB" jobsDatabase :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.JOBS_VALIDATOR" jobsValidator :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.JOBS_QUEUE" jobsProducer :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.JOBS_STATE" jobsNamespace :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.SETTINGS" settingsBinding :: JSVal -> IO JSVal

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

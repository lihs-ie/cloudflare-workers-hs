module Quickstart.Runtime (redirectFetch, managementFetch, exportFetch, recoveryFetch, aggregationQueue, generationQueue, recoveryQueue, maintenanceScheduled, coordinatorRequest, coordinatorAlarmEntry) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace, DurableObjectStorage(..))
import Quickstart.Background.Coordinator qualified as Coordinator
import Cloudflare.Workers.Binding.D1 (D1)
import Cloudflare.Workers.Binding.Queue (QueueProducer)
import Cloudflare.Workers.Binding.R2 (R2Bucket)
import Cloudflare.Workers.Binding.Var (Var, unVar)
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Entrypoint.Queue
import Cloudflare.Workers.Entrypoint.Queue.Typed
import Cloudflare.Workers.Entrypoint.Scheduled
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Cloudflare.Workers.HTTP (Request(..), Response)
import Cloudflare.Workers.Middleware (withRequestId, withStructuredLogging, generateRequestId, currentMillis)
import Cloudflare.Workers.Observability (defaultLoggerConfig, tailLog)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Control.Exception (SomeException, SomeAsyncException, fromException, try, throwIO, catch, evaluate)
import Data.Aeson (FromJSON(..), withObject, (.:))
import Data.Proxy (Proxy(..))
import Data.Text (Text)
import Data.Text qualified as T
import Data.Time.Clock.POSIX (posixSecondsToUTCTime)
import Data.Time (UTCTime)
import GHC.Wasm.Prim (JSVal)
import Quickstart.Redirect qualified as Redirect
import Quickstart.Management qualified as Management
import Quickstart.Background.Environment
import Quickstart.Export.Application
import Quickstart.Recovery.Application
import Quickstart.Aggregation.Application
import Quickstart.ExportGeneration.Application
import Quickstart.RecoveryIngest.Application
import Quickstart.Maintenance.Application
import Servant.Cloudflare.Workers.Access
import Servant.API (Raw, (:>))
import Servant.Cloudflare.Workers.Access.Combinator (ZeroTrust, AccessVerifier(..))
import Servant.Cloudflare.Workers.Error (err500, serverErrorToResponse)
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()

-- Each exported entry has its own concrete binding set and API root.
type RedirectBindings = BindingEnv '[] '[] '[ '("DB", D1), '("CLICKS", QueueProducer)]
type AdminBindings = BindingEnv '[] '[] '[ '("DB", D1), '("ACCESS_TEAM", Var), '("ACCESS_AUDIENCE", Var), '("ACCESS_JWKS_URL", Var)]
type BackgroundBindings = BindingEnv '[] '[] '[ '("COORDINATOR", DurableObjectNamespace), '("DB", D1), '("CLICKS", QueueProducer), '("EXPORT_QUEUE", QueueProducer), '("EXPORTS", R2Bucket), '("ACCESS_TEAM", Var), '("ACCESS_AUDIENCE", Var), '("ACCESS_JWKS_URL", Var)]
type DatabaseBindings = BindingEnv '[] '[] '[ '("DB", D1)]

clock :: IO UTCTime
clock = posixSecondsToUTCTime . realToFrac . (/ 1000) <$> currentMillis

redirectFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
redirectFetch = createFetchHandler $ withRequestId $ withStructuredLogging defaultLoggerConfig $ sanitized $ \request (env :: RedirectBindings) context ->
  serveWithContext (Proxy @Redirect.API) EmptyContext Redirect.server request context
    (Redirect.RedirectEnv (getBinding (Proxy @"DB") env) (getBinding (Proxy @"CLICKS") env) clock)

-- Explicit policy keeps clock tolerance and JWKS freshness reviewable.
accessPolicy :: AccessVerifierOptions
accessPolicy = defaultAccessVerifierOptions
  { accessVerifierOptionsClockSkewSeconds = 0
  , accessVerifierOptionsJWKSCacheTtlSeconds = 3600
  }

accessVerifier :: Text -> Text -> Text -> AccessVerifier
accessVerifier team audience jwks = AccessVerifier $ \assertion ->
  if accessVerifierOptionsClockSkewSeconds accessPolicy < 0
      || accessVerifierOptionsJWKSCacheTtlSeconds accessPolicy <= 0
    then pure (Left (AccessErrorMalformed "Invalid Access policy"))
    else verifyAccessJWTWithOptions accessPolicy (AccessConfig audience team jwks) assertion

managementFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
managementFetch = createFetchHandler $ withRequestId $ withStructuredLogging defaultLoggerConfig $ sanitized $ \request (env :: AdminBindings) context -> do
  let verifier = accessVerifier (unVar $ getBinding (Proxy @"ACCESS_TEAM") env) (unVar $ getBinding (Proxy @"ACCESS_AUDIENCE") env) (unVar $ getBinding (Proxy @"ACCESS_JWKS_URL") env)
  -- Authenticate the entire application, including unknown paths and methods.
  -- The inner API remains NamedRoutes and receives only a verified subject.
  serveWithContext (Proxy @(ZeroTrust :> Raw)) (verifier :. EmptyContext)
    (\identity _ authenticatedRequest authenticatedContext ->
      serveWithContext (Proxy @Management.API) EmptyContext Management.server authenticatedRequest authenticatedContext
        (Management.ManagementEnv (getBinding (Proxy @"DB") env) (accessClaimsSubject identity) clock (T.filter (/= '-') <$> generateRequestId)))
    request context ()

background :: BackgroundBindings -> Text -> BackgroundEnv
background env administrator = BackgroundEnv
  (getBinding (Proxy @"DB") env) (getBinding (Proxy @"EXPORTS") env)
  (getBinding (Proxy @"CLICKS") env) (getBinding (Proxy @"EXPORT_QUEUE") env)
  administrator clock generateRequestId (getBinding (Proxy @"COORDINATOR") env)

withAdmin :: (BackgroundEnv -> Request -> WorkersExecutionContext -> IO Response) -> Request -> BackgroundBindings -> WorkersExecutionContext -> IO Response
withAdmin action request env context = do
  let verifier = accessVerifier (unVar $ getBinding (Proxy @"ACCESS_TEAM") env) (unVar $ getBinding (Proxy @"ACCESS_AUDIENCE") env) (unVar $ getBinding (Proxy @"ACCESS_JWKS_URL") env)
  serveWithContext (Proxy @(ZeroTrust :> Raw)) (verifier :. EmptyContext)
    (\identity _ authenticatedRequest authenticatedContext -> action (background env (accessClaimsSubject identity)) authenticatedRequest authenticatedContext)
    request context ()

exportFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
exportFetch = createFetchHandler $ withRequestId $ withStructuredLogging defaultLoggerConfig $ sanitized $ withAdmin $ \env request context ->
  serveWithContext (Proxy @ExportAPI) EmptyContext (exportHandler env) request context env

recoveryFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
recoveryFetch = createFetchHandler $ withRequestId $ withStructuredLogging defaultLoggerConfig $ sanitized $ withAdmin $ \env request context ->
  serveWithContext (Proxy @RecoveryAPI) EmptyContext (recoveryHandler env) request context env

consume :: FromJSON a => (QueueMessage -> a -> IO ()) -> QueueBatch -> IO ()
consume = consumeJSONMessagesWith $ \_ _ -> do
  tailLog "queue_message_failed"
  pure (RetryMessage (QueueRetryOptions (Just 5)))

aggregationQueue :: JSVal -> JSVal -> JSVal -> IO ()
aggregationQueue = createQueueHandler $ \batch (env :: DatabaseBindings) _ -> consume (\_ event -> do
  now <- clock
  aggregateClick (getBinding (Proxy @"DB") env) now event) batch

recoveryQueue :: JSVal -> JSVal -> JSVal -> IO ()
recoveryQueue = createQueueHandler $ \batch (env :: DatabaseBindings) _ -> consume (\_ event -> do
  now <- clock
  ingestFailedClick (getBinding (Proxy @"DB") env) now event) batch

newtype ExportQueueMessage = ExportQueueMessage Text
instance FromJSON ExportQueueMessage where
  parseJSON = withObject "Export message" (\value -> ExportQueueMessage <$> value .: "identifier")

generationQueue :: JSVal -> JSVal -> JSVal -> IO ()
generationQueue = createQueueHandler $ \batch (env :: BackgroundBindings) _ -> consume (\message (ExportQueueMessage identifier) -> do
  let workerEnv = background env "background"
  result <- try @SomeException (generateExport workerEnv identifier >>= evaluate)
  case result of
    Right () -> pure ()
    Left exception
      | Just asynchronous <- (fromException exception :: Maybe SomeAsyncException) -> throwIO asynchronous
      | queueMessageAttempts message >= 4 -> failExport workerEnv identifier
      | otherwise -> throwIO exception) batch

maintenanceScheduled :: JSVal -> JSVal -> JSVal -> IO ()
maintenanceScheduled = createScheduledHandler $ \_ (env :: BackgroundBindings) _ -> runMaintenance (background env "background")

coordinatorRequest :: JSVal -> JSVal -> JSVal -> IO JSVal
coordinatorRequest = createFetchHandler $ \request (env :: BindingEnv '[] '[] '[ '("STORAGE", DurableObjectStorage)]) _ ->
  Coordinator.coordinatorFetch request (getBinding (Proxy @"STORAGE") env) clock generateRequestId

coordinatorAlarmEntry :: JSVal -> IO ()
coordinatorAlarmEntry storage = Coordinator.coordinatorAlarm (DurableObjectStorage storage) clock

-- Keep database/transport exception payloads out of application logs.
sanitized :: (Request -> env -> WorkersExecutionContext -> IO Response) -> Request -> env -> WorkersExecutionContext -> IO Response
sanitized action request env context = action request env context `catch` (\(_ :: SomeException) -> do
  tailLog "application_request_failed"
  pure (serverErrorToResponse request err500))

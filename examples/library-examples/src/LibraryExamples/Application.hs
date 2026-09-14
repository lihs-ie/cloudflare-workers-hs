module LibraryExamples.Application (server) where
import Cloudflare.Workers.Binding.R2 (R2Bucket)
import Cloudflare.Workers.Binding.Secret (Secret)
import Cloudflare.Workers.Binding.D1 (D1)
import Cloudflare.Workers.Binding.Queue (QueueProducer)
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace)
import LibraryExamples.Archives (archiveServer)
import LibraryExamples.Attachments (attachmentHandler)
import LibraryExamples.Jobs qualified as Jobs
import LibraryExamples.QueueExamples (queueExampleServer)
import LibraryExamples.Client qualified as Client
import Servant.Cloudflare.Workers.ErrorMapping (mapExceptionsToServerError)
import Servant.Cloudflare.Workers.Error qualified as Errors
import Data.Maybe (fromMaybe)
import LibraryExamples.Configuration qualified as Configuration
import LibraryExamples.Client (clientPolicyExample, clientTargetServer)
import LibraryExamples.Logging qualified as Logging
import LibraryExamples.Database (catalogExample)
import LibraryExamples.Storage (storageScenario)
import LibraryExamples.SocketExamples (SocketEndpoints(..), socketTLSGreeting, socketStructuredGreeting)
import LibraryExamples.R2 (runR2Scenario)
import Cloudflare.Workers.Binding.KV
import Cloudflare.Workers.Binding.ServiceBinding
import Cloudflare.Workers.Cache
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Socket
import Cloudflare.Workers.Streaming
import Control.Exception (bracket, throwIO, try)
import Control.Monad (void)
import Control.Monad.Except (throwError)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (Value, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Proxy (Proxy(..))
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8')
import LibraryExamples.API (API, Routes(..), GuideAPI, GuideRoutes(..))
import Servant.Client.Core (clientIn, BaseUrl(..), Scheme(..), ClientError(..), ResponseF(..))
import Network.HTTP.Types.Status qualified as HTTPStatus
import Servant.Cloudflare.Workers.Client.Fetch (FetchClient, runFetchClientWithServiceBinding)
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Error (ServerError(..))

server :: D1 -> ServiceBinding -> QueueProducer -> DurableObjectNamespace -> Maybe Secret -> BaseUrl -> KV -> ServiceBinding -> SocketConnector -> R2Bucket -> SocketEndpoints -> Configuration.Settings -> Server API env
server database validator producer jobNamespace attachmentSecret clientBase kv service connector bucket endpoints configurationSettings = Routes
  { archives = archiveServer bucket attachmentSecret
  , health = pure (object ["status" .= ("ok" :: Text)])
  , echo = pure
  , conflict = throwError (ServerError 409 "fixture conflict" [] Nothing)
  , writeSettings = liftIO (settings kv)
  , readGuide = liftIO guide
  , deleteGuide = liftIO invalidateGuide
  , serviceRequest = liftIO (callService service)
  , streamRequest = liftIO streamExample
  , loggingPolicy = \profile -> case profile of
      "diagnostics" -> liftIO (Logging.loggingExample profile)
      "warnings" -> liftIO (Logging.loggingExample profile)
      "errors-only" -> liftIO (Logging.loggingExample profile)
      _ -> throwError Errors.err400
  , configuration = pure (Configuration.configurationSummary configurationSettings)
  , databaseCatalog = liftIO (catalogExample database)
  , storageRequest = liftIO . storageScenario kv
  , clientPolicy = liftIO (clientPolicyExample service)
  , clientTarget = clientTargetServer
  , tlsRequest = liftIO (socketTLSGreeting connector SecureTransportOn (tlsAddress endpoints))
  , startTlsRequest = liftIO (socketTLSGreeting connector SecureTransportStartTls (startTlsAddress endpoints))
  , r2Scenario = liftIO . runR2Scenario bucket
  , edgeInfo = \colo -> pure (object ["colo" .= colo])
  , attachments = \segments request _ -> liftIO (attachmentHandler bucket attachmentSecret segments request)
  , queueExamples = queueExampleServer producer kv
  , submitJobs = mapped . Jobs.submitJobs database validator producer
  , jobSettings = mapped . Jobs.updateJobSettings jobNamespace
  , jobHistory = mapped (Jobs.readSettingsHistory jobNamespace)
  , jobStatus = mapped . Jobs.readJobState jobNamespace
  , clientStream = liftIO (Client.clientStreamingExample clientBase{baseUrlPath = "/stream-echo"})
  , clientOptions = \timeout retries delay mode -> do
      options <- either (const (throwError Errors.err400)) pure (Client.mkExampleClientOptions (fromMaybe 10000 timeout) (fromMaybe 2 retries) (fromMaybe 250 delay))
      path <- case fromMaybe "success" mode of
        "success" -> pure "/"
        "slow" -> pure "/slow"
        "retry" -> pure "/disconnect"
        _ -> throwError Errors.err400
      liftIO (Client.clientOptionsExample options clientBase{baseUrlPath = path})
  , tcpStructuredRequest = liftIO (socketStructuredGreeting connector (tcpAddress endpoints))
  , tcpRequest = liftIO (tcpGreeting connector (tcpAddress endpoints))
  }

settings :: KV -> IO Value
settings kv = do
  kvPut kv "display:guide" (KVPutText "Download exports from the management API")
    kvPutDefaultOptions{kvPutOptionsExpirationTtl = Just 3600, kvPutOptionsMetadata = Just "{\"version\":1}"}
  value <- kvGetWithMetadata kv "display:guide" KVReadText kvReadDefaultOptions
  batch <- kvGetMany kv (KVKeyBatch "display:guide" ["display:absent"]) KVBulkReadText kvReadDefaultOptions
  listing <- kvList kv (Just "display:") Nothing (Just 100)
  pure $ object ["value" .= textValue (kvMetadataResultValue value), "metadata" .= kvMetadataResultMetadata value,
    "batch" .= map (\(key, item) -> object ["key" .= key, "value" .= textValue item]) (kvBulkResultValues batch),
    "keys" .= map kvListKeyName (kvListResultKeys listing), "complete" .= kvListResultListComplete listing]
  where
    textValue (Just (KVTextValue text)) = Just text
    textValue _ = Nothing

key :: CacheKey
key = CacheURL "https://library-examples.invalid/guide-v1"

guide :: IO Value
guide = do
  cache <- cacheStorage >>= cacheDefault
  found <- cacheMatch cache key cacheQueryDefaultOptions
  case found of
    Just _ -> pure (object ["cache" .= ("hit" :: Text)])
    Nothing -> do
      cachePut cache key (createResponse (Status 200)
        (headersFromList [("Content-Type", "text/plain"), ("Cache-Control", renderCacheControl (CachePublic (Just 60) Nothing Nothing))])
        (ResponseBodyBytes "Use authenticated management APIs to create short URLs."))
      pure (object ["cache" .= ("miss" :: Text)])

invalidateGuide :: IO Value
invalidateGuide = do
  cache <- cacheStorage >>= cacheDefault
  removed <- cacheDelete cache key cacheQueryDefaultOptions
  pure (object ["removed" .= removed])

callService :: ServiceBinding -> IO Value
callService binding = do
  let client = clientIn (Proxy @GuideAPI) (Proxy @FetchClient)
  result <- runFetchClientWithServiceBinding (guideHealth client) binding (BaseUrl Http "guide.internal" 80 "")
  echoed <- runFetchClientWithServiceBinding (guideEcho client "typed body") binding (BaseUrl Http "guide.internal" 80 "")
  failure <- try @ClientError (runFetchClientWithServiceBinding (guideConflict client) binding (BaseUrl Http "guide.internal" 80 ""))
  failureCode <- case failure of
    Left (FailureResponse _ response) -> pure (HTTPStatus.statusCode (responseStatusCode response))
    _ -> fail "typed client did not preserve the conflict response"
  pure (object ["status" .= (200 :: Int), "health" .= result, "echo" .= echoed, "conflict" .= failureCode])

-- A fixed, operator-controlled fixture address; never accepts arbitrary client hosts.
-- The fixture echoes the request, sends EOF, and bounds the entire exchange.
tcpGreeting :: SocketConnector -> Text -> IO Value
tcpGreeting connector address = bracket
  (socketConnect connector (SocketAddressText address) socketDefaultOptions{socketOptionsAllowHalfOpen = True})
  (void . socketClose)
  (\socket -> do
    either throwIO (const (pure ())) =<< socketOpened socket
    either throwIO pure =<< socketWrite socket "library-examples\n"
    either throwIO pure =<< socketFinishWrite socket
    bytes <- either (fail . show) pure =<< readableStreamToLazyByteString 4096 (socketReadable socket)
    message <- either (fail . show) pure (decodeUtf8' (Lazy.toStrict bytes))
    either throwIO pure =<< socketClose socket
    rejected <- socketWrite socket "after-close"
    case rejected of
      Left SocketError{socketErrorKind = SocketStreamError} -> pure ()
      _ -> fail "closed socket accepted a write"
    pure (object ["message" .= message]))

-- Valid empty chunks must not be mistaken for an ended or stalled stream.
streamExample :: IO Value
streamExample = do
  stream <- readableStreamFromProducer $ \emit -> do
    _ <- emit ""
    _ <- emit "streamed"
    pure StreamProducerCompleted
  bytes <- either (fail . show) pure =<< readableStreamToLazyByteString 4096 stream
  text <- either (fail . show) pure (decodeUtf8' (Lazy.toStrict bytes))
  pure (object ["message" .= text])

-- Only named domain failures are translated; unexpected failures reach sanitized middleware.
mapped action = mapExceptionsToServerError (\failure -> case failure of
  Jobs.JobInput -> Errors.err400
  Jobs.JobMissing -> Errors.err404
  Jobs.JobConflict -> ServerError 409 "Conflict" [] Nothing) (liftIO action)

module Servant.Cloudflare.Workers.Client.Fetch (
    FetchClient (FetchClient, runFetchClient),
    runFetchClientWithServiceBinding,
    FetchClientOptions (..),
    defaultFetchClientOptions,
    FetchTransportError (..),
    fetchWithOptions,
    isAcceptableStatus,
    createFailureResponseError,
    throwUnlessAcceptableStatus,
    classifyFetchTransportError,
    classifyEnvelopeFailure,
    fetchTransportErrorConstructorName,
    isIdempotentMethod,
    requestBodyIsStreaming,
    shouldRetryTransportError,
    retryBackoffDelayMilliseconds,
    maximumRetryBackoffDelayMilliseconds,
    minimumFetchTimeoutMilliseconds,
    maximumFetchTimeoutMilliseconds,
    normalizeFetchClientOptions,
) where

import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding)
import Control.Exception (Exception, throwIO, toException)
import Control.Monad.IO.Class (MonadIO (liftIO))
import Control.Monad.Trans.Except (runExceptT)
import Data.Bifunctor (bimap)
import Data.ByteString.Builder qualified as Builder
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import Data.Text qualified as Text
import Network.HTTP.Types (Method, Status, statusIsSuccessful)
import Servant.Client.Core (
    BaseUrl,
    ClientError (ConnectionError, FailureResponse),
    Request,
    RequestF (requestBody, requestMethod),
    Response,
    ResponseF (responseBody, responseStatusCode),
    RunClient (runRequestAcceptStatus, throwClientError),
    RunStreamingClient (withStreamingRequest),
    StreamingResponse,
 )
import Servant.Client.Core.Request (RequestBody (RequestBodySource))
import Servant.Types.SourceT qualified as SourceT

import Servant.Cloudflare.Workers.Client.Fetch.Request (buildFetchTargetURL, requestHeadersToWorkersHeaders)
import Servant.Cloudflare.Workers.Client.Internal.FFI.Fetch (fetchStreamingViaFFI, fetchViaFFI, serviceFetchViaFFI, serviceFetchStreamingViaFFI, jsDelayMillis)

-- | The original constructor remains available for base-URL-dependent IO.
-- Generated requests additionally receive a transport scoped to this run.
-- Streaming response bodies are valid only within the withStreamingRequest
-- callback. Leaving that scope cancels unfinished bodies and releases readers.
data FetchClient a
    = FetchClient {runFetchClient :: BaseUrl -> IO a}
    | TransportFetchClient
        { runFetchClient :: BaseUrl -> IO a
        , runTransportFetchClient :: Maybe ServiceBinding -> BaseUrl -> IO a
        }

transportFetchClient :: (Maybe ServiceBinding -> BaseUrl -> IO a) -> FetchClient a
transportFetchClient action = TransportFetchClient (action Nothing) action

-- | Run generated Servant requests through a Worker Service Binding.
-- The base URL supplies the request URL; it does not choose the destination Worker.
-- Service Binding fetch does not expose an abort signal in the Workers API here,
-- so this transport has no client timeout. Idempotent buffered requests retain
-- the default retry policy. Streaming requests are never retried.
runFetchClientWithServiceBinding :: FetchClient a -> ServiceBinding -> BaseUrl -> IO a
runFetchClientWithServiceBinding action binding = runWithTransport (Just binding) action

runWithTransport :: Maybe ServiceBinding -> FetchClient a -> BaseUrl -> IO a
runWithTransport _ (FetchClient action) = action
runWithTransport binding action@TransportFetchClient{} = runTransportFetchClient action binding

instance Functor FetchClient where
    fmap f action = transportFetchClient (\binding baseURL -> f <$> runWithTransport binding action baseURL)

instance Applicative FetchClient where
    pure value = FetchClient (const (pure value))
    f <*> g = transportFetchClient (\binding baseURL -> runWithTransport binding f baseURL <*> runWithTransport binding g baseURL)

instance Monad FetchClient where
    action >>= next = transportFetchClient $ \binding baseURL -> do
        value <- runWithTransport binding action baseURL
        runWithTransport binding (next value) baseURL

instance MonadIO FetchClient where
    liftIO io = FetchClient (const io)

instance RunClient FetchClient where
    runRequestAcceptStatus acceptStatus request =
        transportFetchClient (\binding baseURL -> fetchWithTransport binding defaultFetchClientOptions acceptStatus baseURL request)
    throwClientError = liftIO . throwIO

instance RunStreamingClient FetchClient where
    withStreamingRequest request handleStreamingResponse =
        transportFetchClient (\binding baseURL -> dispatchStreamingRequest binding baseURL request handleStreamingResponse)

-- The response body is valid only inside the callback; unfinished bodies are
-- cancelled and their reader locks released when it returns or throws.
dispatchStreamingRequest :: Maybe ServiceBinding -> BaseUrl -> Request -> (StreamingResponse -> IO a) -> IO a
dispatchStreamingRequest binding baseURL request handleStreamingResponse = do
    outcome <- case binding of
        Nothing -> fetchStreamingViaFFI
            (fetchClientOptionsTimeoutMillis defaultFetchClientOptions)
            (buildFetchTargetURL baseURL request)
            (requestMethod request)
            (requestHeadersToWorkersHeaders request)
            (fst <$> requestBody request)
            consumeResponse
        Just service -> serviceFetchStreamingViaFFI service
            (buildFetchTargetURL baseURL request)
            (requestMethod request)
            (requestHeadersToWorkersHeaders request)
            (fst <$> requestBody request)
            consumeResponse
    either (throwIO . classifyEnvelopeFailure) pure outcome
  where
    consumeResponse streamingResponse
        | statusIsSuccessful (responseStatusCode streamingResponse) = handleStreamingResponse streamingResponse
        | otherwise = do
            drainedChunksOutcome <- runExceptT (SourceT.runSourceT (responseBody streamingResponse))
            case drainedChunksOutcome of
                Left sourceError -> throwIO (classifyEnvelopeFailure ("network", Text.pack sourceError))
                Right chunks ->
                    throwIO
                        (createFailureResponseError baseURL request (streamingResponse{responseBody = LazyByteString.fromChunks chunks}))

data FetchClientOptions = FetchClientOptions
    { -- | Timeout until response headers arrive, per HTTP dispatch. It does not
      -- bound response-body consumption, retry delays, or cancellation cleanup.
      fetchClientOptionsTimeoutMillis :: Int
    , fetchClientOptionsMaxRetryAttempts :: Int
    , fetchClientOptionsRetryBaseDelayMillis :: Int
    }
    deriving (Show, Eq)

defaultFetchClientOptions :: FetchClientOptions
defaultFetchClientOptions =
    FetchClientOptions
        { fetchClientOptionsTimeoutMillis = 10000
        , fetchClientOptionsMaxRetryAttempts = 2
        , fetchClientOptionsRetryBaseDelayMillis = 250
        }

normalizeFetchClientOptions :: FetchClientOptions -> FetchClientOptions
normalizeFetchClientOptions options =
    options
        { fetchClientOptionsMaxRetryAttempts =
            max 0 (fetchClientOptionsMaxRetryAttempts options)
        , fetchClientOptionsRetryBaseDelayMillis =
            min
                maximumRetryBackoffDelayMilliseconds
                (max 0 (fetchClientOptionsRetryBaseDelayMillis options))
        , fetchClientOptionsTimeoutMillis =
            min
                maximumFetchTimeoutMilliseconds
                (max minimumFetchTimeoutMilliseconds (fetchClientOptionsTimeoutMillis options))
        }

minimumFetchTimeoutMilliseconds :: Int
minimumFetchTimeoutMilliseconds = 1

maximumFetchTimeoutMilliseconds :: Int
maximumFetchTimeoutMilliseconds = 2147483647

data FetchTransportError
    = FetchTimedOut
    | FetchSubrequestLimitExceeded
    | FetchNetworkFailure Text
    deriving (Show, Eq)

instance Exception FetchTransportError

classifyFetchTransportError :: Text -> Text -> FetchTransportError
classifyFetchTransportError kind message = case kind of
    "timeout" -> FetchTimedOut
    "subrequest-limit" -> FetchSubrequestLimitExceeded
    _ -> FetchNetworkFailure message

fetchTransportErrorConstructorName :: FetchTransportError -> Text
fetchTransportErrorConstructorName FetchTimedOut = "FetchTimedOut"
fetchTransportErrorConstructorName FetchSubrequestLimitExceeded = "FetchSubrequestLimitExceeded"
fetchTransportErrorConstructorName (FetchNetworkFailure _) = "FetchNetworkFailure"

classifyEnvelopeFailure :: (Text, Text) -> ClientError
classifyEnvelopeFailure (kind, message) = ConnectionError (toException (classifyFetchTransportError kind message))

isIdempotentMethod :: Method -> Bool
isIdempotentMethod method = method `elem` idempotentMethods
  where
    idempotentMethods :: [Method]
    idempotentMethods = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]

requestBodyIsStreaming :: Request -> Bool
requestBodyIsStreaming request =
    case fst <$> requestBody request of
        Just (RequestBodySource _) -> True
        _ -> False

shouldRetryTransportError :: FetchTransportError -> Bool
shouldRetryTransportError FetchTimedOut = True
shouldRetryTransportError (FetchNetworkFailure _) = True
shouldRetryTransportError FetchSubrequestLimitExceeded = False

maximumRetryBackoffDelayMilliseconds :: Int
maximumRetryBackoffDelayMilliseconds = 60000

retryBackoffDelayMilliseconds :: Int -> Int -> Int
retryBackoffDelayMilliseconds baseDelayMilliseconds attemptIndex
    | baseDelayMilliseconds <= 0 = 0
    | otherwise = doubleUntilCeiling firstAttemptDelayMilliseconds attemptIndex
  where
    firstAttemptDelayMilliseconds :: Int
    firstAttemptDelayMilliseconds =
        min baseDelayMilliseconds maximumRetryBackoffDelayMilliseconds

    doubleUntilCeiling :: Int -> Int -> Int
    doubleUntilCeiling delayMilliseconds remainingDoublings
        | remainingDoublings <= 0 = delayMilliseconds
        | delayMilliseconds >= maximumRetryBackoffDelayMilliseconds =
            maximumRetryBackoffDelayMilliseconds
        | otherwise =
            doubleUntilCeiling
                (min maximumRetryBackoffDelayMilliseconds (delayMilliseconds * 2))
                (remainingDoublings - 1)

isAcceptableStatus :: Maybe [Status] -> Status -> Bool
isAcceptableStatus Nothing status = statusIsSuccessful status
isAcceptableStatus (Just acceptedStatuses) status = status `elem` acceptedStatuses

createFailureResponseError :: BaseUrl -> Request -> Response -> ClientError
createFailureResponseError baseURL request =
    FailureResponse (bimap (const ()) requestPathBytes request)
  where
    requestPathBytes pathBuilder = (baseURL, LazyByteString.toStrict (Builder.toLazyByteString pathBuilder))

throwUnlessAcceptableStatus :: Maybe [Status] -> BaseUrl -> Request -> Response -> IO ()
throwUnlessAcceptableStatus acceptStatus baseURL request response
    | isAcceptableStatus acceptStatus (responseStatusCode response) = pure ()
    | otherwise = throwIO (createFailureResponseError baseURL request response)

fetchWithOptions :: FetchClientOptions -> Maybe [Status] -> BaseUrl -> Request -> IO Response
fetchWithOptions = fetchWithTransport Nothing

fetchWithTransport :: Maybe ServiceBinding -> FetchClientOptions -> Maybe [Status] -> BaseUrl -> Request -> IO Response
fetchWithTransport binding suppliedOptions acceptStatus baseURL request = do
    response <- attemptDispatch 0
    throwUnlessAcceptableStatus acceptStatus baseURL request response
    pure response
  where
    options :: FetchClientOptions
    options = normalizeFetchClientOptions suppliedOptions

    requestIsIdempotent :: Bool
    requestIsIdempotent = isIdempotentMethod (requestMethod request)

    attemptDispatch :: Int -> IO Response
    attemptDispatch attemptIndex = do
        outcome <-
            (case binding of
                Nothing -> fetchViaFFI (fetchClientOptionsTimeoutMillis options)
                Just service -> serviceFetchViaFFI service)
                (buildFetchTargetURL baseURL request)
                (requestMethod request)
                (requestHeadersToWorkersHeaders request)
                (fst <$> requestBody request)
        case outcome of
            Right response -> pure response
            Left (kind, message)
                | requestIsIdempotent
                , not (requestBodyIsStreaming request)
                , shouldRetryTransportError (classifyFetchTransportError kind message)
                , attemptIndex < fetchClientOptionsMaxRetryAttempts options -> do
                    jsDelayMillis
                        ( retryBackoffDelayMilliseconds
                            (fetchClientOptionsRetryBaseDelayMillis options)
                            attemptIndex
                        )
                    attemptDispatch (attemptIndex + 1)
                | otherwise -> throwIO (classifyEnvelopeFailure (kind, message))

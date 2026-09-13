module Servant.Cloudflare.Workers.Client.Internal.FFI.Fetch (
    fetchViaFFI,
    serviceFetchViaFFI,
    serviceFetchStreamingViaFFI,
    buildServiceRequest,
    workersResponseToStreamingResponse,
    fetchStreamingViaFFI,
    jsDelayMillis,
) where

import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding, ServiceBindingError, serviceFetch)
import Cloudflare.Workers.Fetch qualified as WorkersFetch
import Cloudflare.Workers.HTTP qualified as Workers
import Cloudflare.Workers.Headers (Headers, headersToList)
import Cloudflare.Workers.Streaming (
    ReadableStream,
    ReadableStreamReadError (..),
    ReadableStreamReader,
    StreamEmitOutcome (StreamEmitAccepted, StreamEmitCancelled),
    StreamProducerOutcome (StreamProducerCompleted, StreamProducerFailed),
    readReadableStreamChunk,
    readableStreamFromProducer,
    withReadableStreamReader,
 )
import Cloudflare.Workers.URL (parseURL)
import Control.Exception (displayException, try)
import Control.Monad (join)
import Control.Monad.Trans.Except (runExceptT)
import Data.ByteString (ByteString)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.CaseInsensitive (mk)
import Data.Sequence qualified as Sequence
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import GHC.Wasm.Prim (JSVal)
import Network.HTTP.Types (HeaderName, Method, Status (Status), http11)
import Servant.Client.Core (
    RequestBody (RequestBodyBS, RequestBodyLBS, RequestBodySource),
    Response,
    ResponseF (..),
    StreamingResponse,
 )
import Servant.Types.SourceT qualified as SourceT

fetchViaFFI :: Int -> Text -> Method -> Headers -> Maybe RequestBody -> IO (Either (Text, Text) Response)
fetchViaFFI timeoutMilliseconds targetURL method workersHeaders maybeRequestBody =
    fmap join $
        fetchStreamingViaFFI timeoutMilliseconds targetURL method workersHeaders maybeRequestBody $ \response -> do
            drained <- runExceptT (SourceT.runSourceT (responseBody response))
            pure $ case drained of
                Left failure -> Left ("network", Text.pack failure)
                Right chunks -> Right response{responseBody = LazyByteString.fromChunks chunks}

fetchStreamingViaFFI :: Int -> Text -> Method -> Headers -> Maybe RequestBody -> (StreamingResponse -> IO a) -> IO (Either (Text, Text) a)
fetchStreamingViaFFI timeoutMilliseconds targetURL method workersHeaders maybeRequestBody handleResponse = do
    requestOutcome <- buildServiceRequest targetURL method workersHeaders maybeRequestBody
    case requestOutcome of
        Left failure -> pure (Left ("network", failure))
        Right request -> do
            outcome <-
                WorkersFetch.fetch
                    WorkersFetch.FetchOptions
                        { WorkersFetch.fetchOptionsTimeoutMilliseconds = timeoutMilliseconds
                        }
                    request
            case outcome of
                Left failure -> pure (Left (workersFetchFailure failure))
                Right response -> Right <$> workersFetchResponseToStreamingResponse response handleResponse

workersFetchFailure :: WorkersFetch.FetchError -> (Text, Text)
workersFetchFailure (WorkersFetch.FetchTimedOut message) = ("timeout", message)
workersFetchFailure (WorkersFetch.FetchSubrequestLimitExceeded message) = ("subrequest-limit", message)
workersFetchFailure (WorkersFetch.FetchNetworkFailed message) = ("network", message)

-- Service Binding transport deliberately calls the public library API; it never
-- replaces global fetch, so concurrent client runs cannot affect each other.
serviceFetchViaFFI :: ServiceBinding -> Text -> Method -> Headers -> Maybe RequestBody -> IO (Either (Text, Text) Response)
serviceFetchViaFFI binding url method headers body =
    fmap join $ serviceFetchStreamingViaFFI binding url method headers body $ \response -> do
        drained <- runExceptT (SourceT.runSourceT (responseBody response))
        pure $ case drained of
            Left failure -> Left ("network", Text.pack failure)
            Right chunks -> Right response{responseBody = LazyByteString.fromChunks chunks}

serviceFetchStreamingViaFFI :: ServiceBinding -> Text -> Method -> Headers -> Maybe RequestBody -> (StreamingResponse -> IO a) -> IO (Either (Text, Text) a)
serviceFetchStreamingViaFFI binding url method headers body handleResponse = do
    requestOutcome <- buildServiceRequest url method headers body
    case requestOutcome of
        Left failure -> pure (Left ("network", failure))
        Right request -> do
            outcome <- try @ServiceBindingError (serviceFetch binding request)
            case outcome of
                Left failure -> pure (Left ("network", Text.pack (displayException failure)))
                Right response -> Right <$> workersResponseToStreamingResponse response handleResponse

buildServiceRequest :: Text -> Method -> Headers -> Maybe RequestBody -> IO (Either Text Workers.Request)
buildServiceRequest target method headers body = case parseURL target of
    Nothing -> pure (Left "Invalid Service Binding request URL")
    Just url -> do
        (stream, reader) <- case body of
            Nothing -> pure (Nothing, Nothing)
            Just (RequestBodyBS bytes) -> pure (Nothing, Just (const (pure (Right (LazyByteString.fromStrict bytes)))))
            Just (RequestBodyLBS bytes) -> pure (Nothing, Just (const (pure (Right bytes))))
            Just (RequestBodySource source) -> do
                requestStream <- requestBodySourceToReadableStream source
                pure (Just requestStream, Nothing)
        pure $
            Right $
                Workers.Request
                    (Workers.methodFromText (TextEncoding.decodeUtf8 method))
                    url
                    stream
                    headers
                    reader
                    Nothing

-- The SourceT belongs to the callback scope and must not escape it.
workersResponseToStreamingResponse :: Workers.Response -> (StreamingResponse -> IO a) -> IO a
workersResponseToStreamingResponse =
    workersResponseToStreamingResponseWithStatusText ""

workersFetchResponseToStreamingResponse :: WorkersFetch.FetchResponse -> (StreamingResponse -> IO a) -> IO a
workersFetchResponseToStreamingResponse response =
    workersResponseToStreamingResponseWithStatusText
        (TextEncoding.encodeUtf8 (WorkersFetch.fetchResponseStatusText response))
        (WorkersFetch.fetchResponseValue response)

workersResponseToStreamingResponseWithStatusText :: ByteString -> Workers.Response -> (StreamingResponse -> IO a) -> IO a
workersResponseToStreamingResponseWithStatusText statusText response handleResponse =
    withSource $ \source ->
        handleResponse
            Response
                { responseStatusCode = Status (Workers.statusCode (Workers.responseStatus response)) statusText
                , responseHeaders = toClientCoreHeaders (Workers.responseHeaders response)
                , responseHttpVersion = http11
                , responseBody = source
                }
  where
    withSource consume = case Workers.responseBody response of
        Workers.ResponseBodyBytes bytes -> consume (SourceT.source [bytes])
        Workers.ResponseBodyLazyBytes bytes -> consume (SourceT.source (LazyByteString.toChunks bytes))
        Workers.ResponseBodyStream stream -> withStreamSource stream consume
        Workers.ResponseBodyPassthrough _ -> fail "Passthrough responses cannot be consumed by the Servant client"
        Workers.ResponseBodyWebSocket _ -> fail "WebSocket upgrades require the WebSocket API"

toClientCoreHeaders :: Headers -> Sequence.Seq (HeaderName, ByteString)
toClientCoreHeaders workersHeaders =
    Sequence.fromList
        [(mk (TextEncoding.encodeUtf8 name), TextEncoding.encodeUtf8 value) | (name, value) <- headersToList workersHeaders]

withStreamSource :: ReadableStream -> (SourceT.SourceT IO ByteString -> IO a) -> IO a
withStreamSource stream consume =
    withReadableStreamReader stream $ \reader ->
        consume (SourceT.fromStepT (pullStep reader))

pullStep :: ReadableStreamReader -> SourceT.StepT IO ByteString
pullStep reader = SourceT.Effect $ do
    readOutcome <- readReadableStreamChunk reader
    pure $ case readOutcome of
        Left failure -> SourceT.Error (Text.unpack (readFailureMessage failure))
        Right Nothing -> SourceT.Stop
        Right (Just chunk) -> SourceT.Yield chunk (pullStep reader)

readFailureMessage :: ReadableStreamReadError -> Text
readFailureMessage ReadableStreamExceededByteLimit = "response stream exceeded its byte limit"
readFailureMessage ReadableStreamStalled = "response stream stalled"
readFailureMessage (ReadableStreamReadFailed message) = message

requestBodySourceToReadableStream :: SourceT.SourceT IO LazyByteString.ByteString -> IO ReadableStream
requestBodySourceToReadableStream bodySource = readableStreamFromProducer (produceRequestBodyChunks bodySource)

produceRequestBodyChunks ::
    SourceT.SourceT IO LazyByteString.ByteString ->
    (ByteString -> IO StreamEmitOutcome) ->
    IO StreamProducerOutcome
produceRequestBodyChunks bodySource emitChunk = SourceT.unSourceT bodySource unrollStep
  where
    unrollStep step = case step of
        SourceT.Stop -> pure StreamProducerCompleted
        SourceT.Error streamingError -> pure (StreamProducerFailed (Text.pack streamingError))
        SourceT.Skip rest -> unrollStep rest
        SourceT.Effect action -> action >>= unrollStep
        SourceT.Yield chunk rest
            | LazyByteString.null chunk -> unrollStep rest
            | otherwise -> do
                emitOutcome <- emitChunk (LazyByteString.toStrict chunk)
                case emitOutcome of
                    StreamEmitAccepted -> unrollStep rest
                    StreamEmitCancelled -> pure StreamProducerCompleted

foreign import javascript safe
    """
    (async () => {
      await new Promise(resolve => setTimeout(resolve, $1));
      return { slept: true };
    })()
    """
    jsDelayMillisEnveloped :: Int -> IO JSVal

foreign import javascript unsafe "$1.slept === true"
    jsSleepEnvelopeSleptField :: JSVal -> IO Bool

jsDelayMillis :: Int -> IO ()
jsDelayMillis delayMilliseconds = do
    sleepEnvelopeJSVal <- jsDelayMillisEnveloped delayMilliseconds
    slept <- jsSleepEnvelopeSleptField sleepEnvelopeJSVal
    if slept
        then pure ()
        else error "jsDelayMillis: the sleep envelope reported slept=false, a shape its own JS snippet never produces"

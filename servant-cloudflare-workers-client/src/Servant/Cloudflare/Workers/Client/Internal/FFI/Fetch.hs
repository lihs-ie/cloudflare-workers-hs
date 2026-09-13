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
import Cloudflare.Workers.HTTP qualified as Workers
import Cloudflare.Workers.URL (parseURL)
import Control.Exception (bracket, displayException, try)
import Control.Monad.Trans.Except (runExceptT)
import Cloudflare.Workers.Headers (Headers, headersToList)
import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString)
import Cloudflare.Workers.Internal.FFI.Envelope (
    EnvelopeTag (EnvelopeFailureTag, EnvelopeMalformedTag, EnvelopeSuccessTag),
    decodeEnveloped,
    describeMalformedEnvelope,
    readEnvelopeTag,
 )
import Cloudflare.Workers.Internal.FFI.Headers (headersFromJSVal, headersToJSVal)
import Cloudflare.Workers.Internal.FFI.Stream (readableStreamGetReaderViaFFI, readableStreamReaderReadViaFFI)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Streaming (
    ReadableStream,
    StreamEmitOutcome (StreamEmitAccepted, StreamEmitCancelled),
    StreamProducerOutcome (StreamProducerCompleted, StreamProducerFailed),
    readableStreamFromProducer,
    readableStreamToJSVal,
 )
import Control.Monad (join)
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
fetchViaFFI timeoutMillis targetURL method workersHeaders maybeRequestBody = do
    envelopeJSVal <- dispatchFetchEnveloped timeoutMillis targetURL method workersHeaders maybeRequestBody
    join <$> decodeFetchEnvelopeWith responseFromEnvelopeValue envelopeJSVal

fetchStreamingViaFFI :: Int -> Text -> Method -> Headers -> Maybe RequestBody -> (StreamingResponse -> IO a) -> IO (Either (Text, Text) a)
fetchStreamingViaFFI timeoutMillis targetUrl method workersHeaders maybeRequestBody handleResponse = do
    envelopeJSVal <- dispatchFetchEnveloped timeoutMillis targetUrl method workersHeaders maybeRequestBody
    decodeFetchEnvelopeWith (`responseFromEnvelopeValueStreaming` handleResponse) envelopeJSVal

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
        pure $ Right $ Workers.Request
            (Workers.methodFromText (TextEncoding.decodeUtf8 method))
            url stream headers reader Nothing

-- The SourceT belongs to the callback scope and must not escape it.
workersResponseToStreamingResponse :: Workers.Response -> (StreamingResponse -> IO a) -> IO a
workersResponseToStreamingResponse response handleResponse =
    withSource $ \source -> handleResponse Response
        { responseStatusCode = Status (Workers.statusCode (Workers.responseStatus response)) ""
        , responseHeaders = toClientCoreHeaders (Workers.responseHeaders response)
        , responseHttpVersion = http11
        , responseBody = source
        }
  where
    withSource consume = case Workers.responseBody response of
        Workers.ResponseBodyBytes bytes -> consume (SourceT.source [bytes])
        Workers.ResponseBodyLazyBytes bytes -> consume (SourceT.source (LazyByteString.toChunks bytes))
        Workers.ResponseBodyStream stream -> withStreamSource (readableStreamToJSVal stream) consume
        Workers.ResponseBodyPassthrough (Workers.PassthroughResponse rawResponse) -> responseBodySourceT rawResponse consume
        Workers.ResponseBodyWebSocket _ -> fail "WebSocket upgrades require the WebSocket API"

dispatchFetchEnveloped :: Int -> Text -> Method -> Headers -> Maybe RequestBody -> IO JSVal
dispatchFetchEnveloped timeoutMillis targetURL method workersHeaders maybeRequestBody = do
    urlJSVal <- textToJSVal targetURL
    methodJSVal <- textToJSVal (TextEncoding.decodeUtf8 method)
    headersJSVal <- headersToJSVal workersHeaders
    requestJSVal <- buildFetchRequestJSVal urlJSVal methodJSVal headersJSVal maybeRequestBody
    jsFetchEnveloped requestJSVal timeoutMillis

buildFetchRequestJSVal :: JSVal -> JSVal -> JSVal -> Maybe RequestBody -> IO JSVal
buildFetchRequestJSVal urlJSVal methodJSVal headersJSVal Nothing =
    jsNewRequestNoBody urlJSVal methodJSVal headersJSVal
buildFetchRequestJSVal urlJSVal methodJSVal headersJSVal (Just requestBody) = do
    payload <- requestBodyToPayload requestBody
    case payload of
        RequestBodyPayloadBytes bytes -> do
            bodyJSVal <- byteStringToJSByteArray bytes
            jsNewRequestWithBody urlJSVal methodJSVal headersJSVal bodyJSVal
        RequestBodyPayloadStream streamJSVal ->
            jsNewRequestWithStreamBody urlJSVal methodJSVal headersJSVal streamJSVal

data RequestBodyPayload
    = RequestBodyPayloadBytes ByteString
    | RequestBodyPayloadStream JSVal

requestBodyToPayload :: RequestBody -> IO RequestBodyPayload
requestBodyToPayload (RequestBodyLBS lazyBytes) = pure (RequestBodyPayloadBytes (LazyByteString.toStrict lazyBytes))
requestBodyToPayload (RequestBodyBS strictBytes) = pure (RequestBodyPayloadBytes strictBytes)
requestBodyToPayload (RequestBodySource sourseIO) =
    RequestBodyPayloadStream . readableStreamToJSVal <$> requestBodySourceToReadableStream sourseIO

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

malformedEnvelopeKind :: Text
malformedEnvelopeKind = "malformed-envelope"

decodeFetchEnvelopeWith :: (JSVal -> IO a) -> JSVal -> IO (Either (Text, Text) a)
decodeFetchEnvelopeWith marshalValue envelopeJSVal = do
    envelopeTag <- readEnvelopeTag envelopeJSVal
    case envelopeTag of
        EnvelopeSuccessTag -> Right <$> (marshalValue =<< jsEnvelopeValueField envelopeJSVal)
        EnvelopeFailureTag -> do
            kind <- jsValToText =<< jsEnvelopeKindField envelopeJSVal
            message <- jsValToText =<< jsEnvelopeMessageField envelopeJSVal
            pure (Left (kind, message))
        EnvelopeMalformedTag -> do
            description <- describeMalformedEnvelope envelopeJSVal
            pure (Left (malformedEnvelopeKind, description))

responseFromEnvelopeValue :: JSVal -> IO (Either (Text, Text) Response)
responseFromEnvelopeValue responseJSVal = do
    statusCode <- jsResponseStatus responseJSVal
    statusText <- jsValToText =<< jsResponseStatusText responseJSVal
    headers <- jsResponseHeaders responseJSVal
    workersHeaders <- headersFromJSVal headers
    bodyOutcome <- decodeEnveloped pure =<< jsResponseArrayBufferEnveloped responseJSVal
    case bodyOutcome of
        Left drainFailureMessage ->
            pure (Left ("network", "response body drain failed: " <> drainFailureMessage))
        Right bodyArrayBufferJSVal -> do
            bodyByteArrayJSVal <- jsWrapArrayBufferAsUint8Array bodyArrayBufferJSVal
            bodyBytes <- jsByteArrayToByteString bodyByteArrayJSVal
            pure
                ( Right
                    Response
                        { responseStatusCode = Status statusCode (TextEncoding.encodeUtf8 statusText)
                        , responseHeaders = toClientCoreHeaders workersHeaders
                        , responseHttpVersion = http11
                        , responseBody = LazyByteString.fromStrict bodyBytes
                        }
                )

toClientCoreHeaders :: Headers -> Sequence.Seq (HeaderName, ByteString)
toClientCoreHeaders workersHeaders =
    Sequence.fromList
        [(mk (TextEncoding.encodeUtf8 name), TextEncoding.encodeUtf8 value) | (name, value) <- headersToList workersHeaders]

responseFromEnvelopeValueStreaming :: JSVal -> (StreamingResponse -> IO a) -> IO a
responseFromEnvelopeValueStreaming responseJSVal handleResponse = do
    statusCode <- jsResponseStatus responseJSVal
    statusText <- jsValToText =<< jsResponseStatusText responseJSVal
    headersJSVal <- jsResponseHeaders responseJSVal
    workersHeaders <- headersFromJSVal headersJSVal
    responseBodySourceT responseJSVal $ \sourceBody ->
        handleResponse Response
            { responseStatusCode = Status statusCode (TextEncoding.encodeUtf8 statusText)
            , responseHeaders = toClientCoreHeaders workersHeaders
            , responseHttpVersion = http11
            , responseBody = sourceBody
            }

responseBodySourceT :: JSVal -> (SourceT.SourceT IO ByteString -> IO a) -> IO a
responseBodySourceT responseJSVal consume = do
    bodyIsNull <- jsResponseBodyIsNull responseJSVal
    if bodyIsNull
        then consume (SourceT.source ([] :: [ByteString]))
        else do
            bodyStreamJSVal <- jsResponseBody responseJSVal
            withStreamSource bodyStreamJSVal consume

-- Both transports own the reader for the entire callback, including status
-- failure draining. Early return or an exception cancels the unfinished body.
-- Cleanup rejection must never replace the original consumer/producer failure.
withStreamSource :: JSVal -> (SourceT.SourceT IO ByteString -> IO a) -> IO a
withStreamSource stream consume =
    bracket (readableStreamGetReaderViaFFI stream) closeResponseReader $ \reader ->
        consume (SourceT.fromStepT (pullStep reader))

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.cancel();
      } catch (_) {
      } finally {
        try {
          $1.releaseLock();
        } catch (_) {}
      }
      return { closed: true };
    })()
    """
    jsCloseResponseReader :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.closed === true"
    jsResponseReaderClosed :: JSVal -> IO Bool

closeResponseReader :: JSVal -> IO ()
closeResponseReader reader = do
    -- A safe JSFFI promise must have its result forced before returning to JS.
    -- IO () alone can discard the lazy result before the async cleanup finishes.
    result <- jsCloseResponseReader reader
    closed <- jsResponseReaderClosed result
    if closed
        then pure ()
        else error "Response reader cleanup did not complete"

pullStep :: JSVal -> SourceT.StepT IO ByteString
pullStep readerJSVal = SourceT.Effect $ do
    readOutcome <- readableStreamReaderReadViaFFI readerJSVal
    case readOutcome of
        Left errorMessage -> pure (SourceT.Error (Text.unpack errorMessage))
        Right Nothing -> pure SourceT.Stop
        Right (Just chunkByteString) -> pure (SourceT.Yield chunkByteString (pullStep readerJSVal))

foreign import javascript safe
    """
    (async () => {
      const controller = new AbortController();
      const timeoutID = setTimeout(() => controller.abort(), $2);

      try {
        const response = await fetch($1, {
          signal: controller.signal
        });

        clearTimeout(timeoutID);

        return {
          ok: true,
          value: response,
          kind: null,
          message: null
        };
      } catch (error) {
        clearTimeout(timeoutID);

        try {
          if ($1.body) {
            await $1.body.cancel();
          }
        } catch {}

        const name = error && error.name;
        const message = String((error && error.message) || error);

        if (name === 'AbortError') {
          return {
            ok: false,
            value: null,
            kind: 'timeout',
            message
          };
        };

        if (/too many subrequests/i.test(message)) {
          return {
            ok: false,
            value: null,
            kind: 'subrequest-limit',
            message
          };
        };

        return {
          ok: false,
          value: null,
          kind: 'network',
          message
        };
      }
    })()
    """
    jsFetchEnveloped :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "new Request($1, { method: $2, headers: $3, body: $4 })"
    jsNewRequestWithBody :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "new Request($1, { method: $2, headers: $3 })"
    jsNewRequestNoBody :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "new Request($1, { method: $2, headers: $3, body: $4 })"
    jsNewRequestWithStreamBody :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.value"
    jsEnvelopeValueField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.kind"
    jsEnvelopeKindField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.message"
    jsEnvelopeMessageField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const statusCode = $1.status;

      if (!Number.isSafeInteger(statusCode) || statusCode < 0 || statusCode > 2147483647) {
        throw new TypeError('the fetch Response status is not a non-negative 32-bit integer: ' + typeof statusCode);
      }

      return statusCode;    })()
    """
    jsResponseStatus :: JSVal -> IO Int

foreign import javascript unsafe "$1.statusText"
    jsResponseStatusText :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.headers"
    jsResponseHeaders :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.arrayBuffer()
        };
      } catch (error) {
        return {
          ok: false,
          message: String((error && error.message) || error)
        };
      }
    })()
    """
    jsResponseArrayBufferEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.body === null"
    jsResponseBodyIsNull :: JSVal -> IO Bool

foreign import javascript unsafe "$1.body"
    jsResponseBody :: JSVal -> IO JSVal

foreign import javascript unsafe "new Uint8Array($1)"
    jsWrapArrayBufferAsUint8Array :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      await new Promise(resolve => setTimeout(resolve, $1));

      return {
        slept: true
      };
    })()
    """
    jsDelayMillisEnveloped :: Int -> IO JSVal

foreign import javascript unsafe "$1.slept === true"
    jsSleepEnvelopeSleptField :: JSVal -> IO Bool

jsDelayMillis :: Int -> IO ()
jsDelayMillis delayMillis = do
    sleepEnvelopeJSVal <- jsDelayMillisEnveloped delayMillis
    slept <- jsSleepEnvelopeSleptField sleepEnvelopeJSVal
    if slept
        then pure ()
        else error "jsDelayMillis: the sleep envelope reported slept=false, a shape its own JS snippet never produces"

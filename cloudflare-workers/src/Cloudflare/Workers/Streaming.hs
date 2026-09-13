module Cloudflare.Workers.Streaming (
    readableStreamCancel,
    readableStreamWithLength,
    readableStreamToLazyByteString,
    readableStreamFromProducer,
    StreamEmitOutcome (..),
    StreamProducerOutcome (..),
    ReadableStreamReadError (..),
    ReadableStreamReader,
    withReadableStreamReader,
    readReadableStreamChunk,
    ReadableStream,
) where

import Cloudflare.Workers.Internal.FFI.Stream (
    StreamDrainFailure (StreamDrainFailure),
    StreamDrainOutcome (..),
    producerDrivenReadableStreamViaFFI,
    readableStreamCancelViaFFI,
    readableStreamDrain,
    readableStreamReaderReadViaFFI,
    readableStreamWithLengthViaFFI,
    withReadableStreamReaderViaFFI,
 )
import Cloudflare.Workers.Internal.Streaming (ReadableStream, readableStreamFromJSVal, readableStreamToJSVal)
import Control.Exception (throwIO)
import Data.ByteString qualified as BytesString
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

data ReadableStreamReadError
    = ReadableStreamExceededByteLimit
    | ReadableStreamStalled
    | ReadableStreamReadFailed Text
    deriving stock (Show, Eq)

newtype ReadableStreamReader = ReadableStreamReader JSVal

withReadableStreamReader :: ReadableStream -> (ReadableStreamReader -> IO a) -> IO a
withReadableStreamReader stream useReader =
    let streamJSValue = readableStreamToJSVal stream
     in
    withReadableStreamReaderViaFFI streamJSValue (useReader . ReadableStreamReader)

readReadableStreamChunk :: ReadableStreamReader -> IO (Either ReadableStreamReadError (Maybe BytesString.ByteString))
readReadableStreamChunk (ReadableStreamReader readerJSValue) =
    fmap (either (Left . ReadableStreamReadFailed) Right) (readableStreamReaderReadViaFFI readerJSValue)

readableStreamToLazyByteString :: Int -> ReadableStream -> IO (Either ReadableStreamReadError LazyByteString.ByteString)
readableStreamToLazyByteString byteLimit stream = do
    let streamJSValue = readableStreamToJSVal stream
    outcome <- readableStreamDrain byteLimit streamJSValue
    case outcome of
        StreamDrainCompleted lazyByteString -> pure (Right lazyByteString)
        StreamDrainByteLimitExceeded -> pure (Left ReadableStreamExceededByteLimit)
        StreamDrainStalled -> pure (Left ReadableStreamStalled)
        StreamDrainFailed failureMessage -> throwIO (StreamDrainFailure failureMessage)

data StreamEmitOutcome
    = StreamEmitAccepted
    | StreamEmitCancelled
    deriving stock (Show, Eq)

data StreamProducerOutcome
    = StreamProducerCompleted
    | StreamProducerFailed Text
    deriving stock (Show, Eq)

readableStreamFromProducer ::
    ((BytesString.ByteString -> IO StreamEmitOutcome) -> IO StreamProducerOutcome) ->
    IO ReadableStream
readableStreamFromProducer produce =
    readableStreamFromJSVal <$> producerDrivenReadableStreamViaFFI produceViaFFI
  where
    outcomeToMaybeMessage StreamProducerCompleted = Nothing
    outcomeToMaybeMessage (StreamProducerFailed failureMessage) = Just failureMessage

    emitOutcomeFromBool delivered = if delivered then StreamEmitAccepted else StreamEmitCancelled

    produceViaFFI emitViaFFI = outcomeToMaybeMessage <$> produce (fmap emitOutcomeFromBool . emitViaFFI)

{- | Attach an exact byte count using the runtime's native FixedLengthStream.
A producer emitting a different count fails the stream, rather than truncating
or padding data. Source errors propagate through the pipe; use
'readableStreamCancel' to cancel and await an idle upstream producer.
-}
readableStreamWithLength :: Integer -> ReadableStream -> IO ReadableStream
readableStreamWithLength byteLength stream =
    readableStreamFromJSVal <$> readableStreamWithLengthViaFFI byteLength (readableStreamToJSVal stream)

-- | Cancel an unconsumed stream and release its upstream producer.
readableStreamCancel :: ReadableStream -> IO ()
readableStreamCancel = readableStreamCancelViaFFI . readableStreamToJSVal

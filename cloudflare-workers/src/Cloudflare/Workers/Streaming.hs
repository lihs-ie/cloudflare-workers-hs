module Cloudflare.Workers.Streaming (
    readableStreamCancel,
    readableStreamWithLength,
    readableStreamToLazyByteString,
    producerDrivenReadableStreamViaFFI,
    readableStreamFromProducer,
    StreamDrainOutcome (..),
    StreamEmitOutcome (..),
    StreamProducerOutcome (..),
    ReadableStreamReadError (..),
    readableStreamFromJSVal,
    ReadableStream (..),
    readableStreamToJSVal,
) where

import Cloudflare.Workers.Internal.FFI.Stream (
    readableStreamCancelViaFFI,
    readableStreamWithLengthViaFFI,
    StreamDrainFailure (StreamDrainFailure),
    StreamDrainOutcome (..),
    producerDrivenReadableStreamViaFFI,
    readableStreamDrain,
 )
import Control.Exception (throwIO)
import Data.ByteString qualified as BytesString
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

newtype ReadableStream = ReadableStream JSVal

data ReadableStreamReadError
    = ReadableStreamExceededByteLimit
    | ReadableStreamStalled
    deriving stock (Show, Eq)

readableStreamToLazyByteString :: Int -> ReadableStream -> IO (Either ReadableStreamReadError LazyByteString.ByteString)
readableStreamToLazyByteString byteLimit (ReadableStream streamJSValue) = do
    outcome <- readableStreamDrain byteLimit streamJSValue
    case outcome of
        StreamDrainCompleted lazyByteString -> pure (Right lazyByteString)
        StreamDrainByteLimitExceeded -> pure (Left ReadableStreamExceededByteLimit)
        StreamDrainStalled -> pure (Left ReadableStreamStalled)
        StreamDrainFailed failureMessage -> throwIO (StreamDrainFailure failureMessage)

readableStreamFromJSVal :: JSVal -> ReadableStream
readableStreamFromJSVal = ReadableStream

readableStreamToJSVal :: ReadableStream -> JSVal
readableStreamToJSVal (ReadableStream streamJSValue) = streamJSValue

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
    ReadableStream <$> producerDrivenReadableStreamViaFFI produceViaFFI
  where
    outcomeToMaybeMessage StreamProducerCompleted = Nothing
    outcomeToMaybeMessage (StreamProducerFailed failureMessage) = Just failureMessage

    emitOutcomeFromBool delivered = if delivered then StreamEmitAccepted else StreamEmitCancelled

    produceViaFFI emitViaFFI = outcomeToMaybeMessage <$> produce (fmap emitOutcomeFromBool . emitViaFFI)

-- | Attach an exact byte count using the runtime's native FixedLengthStream.
-- A producer emitting a different count fails the stream, rather than truncating
-- or padding data. Source errors propagate through the pipe; use
-- 'readableStreamCancel' to cancel and await an idle upstream producer.
readableStreamWithLength :: Integer -> ReadableStream -> IO ReadableStream
readableStreamWithLength byteLength (ReadableStream source) =
    ReadableStream <$> readableStreamWithLengthViaFFI byteLength source

-- | Cancel an unconsumed stream and release its upstream producer.
readableStreamCancel :: ReadableStream -> IO ()
readableStreamCancel (ReadableStream source) = readableStreamCancelViaFFI source

module Cloudflare.Workers.Internal.FFI.Stream (
    readableStreamCancelViaFFI,
    readableStreamWithLengthViaFFI,
    readableStreamDrain,
    readableStreamToLazyByteString,
    StreamDrainOutcome (..),
    StreamDrainFailure (..),
    producerDrivenReadableStreamViaFFI,
    readableStreamGetReaderViaFFI,
    readableStreamReaderReadViaFFI,
    streamDrainStepDecision,
    StreamDrainStep (..),
) where

import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Control.Concurrent (forkIO)
import Control.Exception (Exception (displayException), SomeException, throwIO, try, bracket, onException)
import Data.ByteString qualified as ByteString
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

readableStreamToLazyByteString :: Int -> JSVal -> IO (Maybe LazyByteString.ByteString)
readableStreamToLazyByteString byteLimit streamJSValue = do
    outcome <- readableStreamDrain byteLimit streamJSValue
    case outcome of
        StreamDrainCompleted lazyByteString -> pure (Just lazyByteString)
        StreamDrainByteLimitExceeded -> pure Nothing
        StreamDrainStalled -> pure Nothing
        StreamDrainFailed failureMessage -> throwIO (StreamDrainFailure failureMessage)

data StreamDrainStep
    = StreamDrainContinue Integer
    | StreamDrainStopByteLimitExceeded
    | StreamDrainStopStalled
    deriving stock (Show, Eq)

data StreamDrainOutcome
    = StreamDrainCompleted LazyByteString.ByteString
    | StreamDrainByteLimitExceeded
    | StreamDrainStalled
    | StreamDrainFailed Text
    deriving stock (Show, Eq)

newtype StreamDrainFailure = StreamDrainFailure Text
    deriving stock (Show, Eq)

instance Exception StreamDrainFailure

-- The limit is checked on the JS view before copying a chunk into WASM.
-- Early termination cancels the producer; every path releases the reader lock.
readableStreamDrain :: Int -> JSVal -> IO StreamDrainOutcome
readableStreamDrain byteLimit streamJSValue =
    bracket (jsGetReader streamJSValue) jsReleaseReader $ \reader -> do
        outcome <- (if byteLimit < 0 then pure StreamDrainByteLimitExceeded else drainFrom reader 0 [])
            `onException` jsCancelReader reader
        case outcome of
            StreamDrainCompleted _ -> pure outcome
            _ -> jsCancelReader reader >> pure outcome
  where
    drainFrom reader totalBytesRead reverseChunks = do
        readOutcome <- boundedReaderRead reader (byteLimit - totalBytesRead)
        case readOutcome of
            Left failureMessage -> pure (StreamDrainFailed failureMessage)
            Right (Left ()) -> pure StreamDrainByteLimitExceeded
            Right (Right Nothing) -> pure (StreamDrainCompleted (LazyByteString.fromChunks (reverse reverseChunks)))
            -- Empty chunks are valid and do not consume the byte budget.
            Right (Right (Just chunk)) | ByteString.null chunk -> drainFrom reader totalBytesRead reverseChunks
            Right (Right (Just chunk)) -> drainFrom reader (totalBytesRead + ByteString.length chunk) (chunk : reverseChunks)

boundedReaderRead :: JSVal -> Int -> IO (Either Text (Either () (Maybe ByteString.ByteString)))
boundedReaderRead reader remaining = do
    envelope <- jsReaderReadEnveloped reader
    decodeEnveloped decode envelope
  where
    decode result = do
        done <- jsReadResultDone result
        if done then pure (Right Nothing) else do
            chunk <- jsReadResultValue result
            exceeds <- jsChunkExceedsLimit chunk remaining
            if exceeds then pure (Left ()) else Right . Just <$> jsByteArrayToByteString chunk

-- Typed arrays can shadow .byteLength. Inspect their intrinsic size before
-- allocating or copying bytes; never invoke a caller-owned property getter.
foreign import javascript unsafe
    """
    (() => {
      const chunk = $1;
      if (!ArrayBuffer.isView(chunk)) {
        return false;
      }
      const prototype = Object.getPrototypeOf(Uint8Array.prototype);
      const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag).get.call(chunk);
      if (tag === undefined) {
        // DataView has no typed-array shape; the Bytes decoder rejects it.
        return false;
      }
      const byteLength = Object.getOwnPropertyDescriptor(prototype, 'byteLength').get.call(chunk);
      return byteLength > $2;
    })()
    """
    jsChunkExceedsLimit :: JSVal -> Int -> IO Bool

-- Force the safe JSFFI result: IO () can discard a lazy promise before the
-- producer's asynchronous cancellation finishes. Cleanup rejection is ignored
-- so it cannot replace the read failure or byte-limit outcome being returned.
jsCancelReader :: JSVal -> IO ()
jsCancelReader reader = do
    result <- jsCancelReaderEnveloped reader
    completed <- jsCancellationCompleted result
    if completed
        then pure ()
        else error "Stream reader cancellation did not complete"

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.cancel();
      } catch (_) {}
      return { completed: true };
    })()
    """
    jsCancelReaderEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.completed === true"
    jsCancellationCompleted :: JSVal -> IO Bool

foreign import javascript unsafe "(() => { try { $1.releaseLock(); } catch (_) {} })()"
    jsReleaseReader :: JSVal -> IO ()

streamDrainStepDecision :: Integer -> Int -> Int -> StreamDrainStep
streamDrainStepDecision totalBytesRead byteLimit chunkByteCount
    | chunkByteCount <= 0 = StreamDrainStopStalled
    | newTotalBytesRead > toInteger byteLimit = StreamDrainStopByteLimitExceeded
    | otherwise = StreamDrainContinue newTotalBytesRead
  where
    newTotalBytesRead = totalBytesRead + toInteger chunkByteCount

producerDrivenReadableStreamViaFFI ::
    ((ByteString.ByteString -> IO Bool) -> IO (Maybe Text)) ->
    IO JSVal
producerDrivenReadableStreamViaFFI produce = do
    envelopeJSVal <- jsMakePullEnvelope
    _threadID <- forkIO (runProducer envelopeJSVal)
    jsPullEnvelopeStream envelopeJSVal
  where
    runProducer envelopeJSVal = do
        outcome <- try (produce (emitOneChunk envelopeJSVal))
        case outcome of
            Right Nothing -> jsPullEnvelopeClose envelopeJSVal
            Right (Just failureMessage) -> errorStream envelopeJSVal failureMessage
            Left exception ->
                errorStream envelopeJSVal (Text.pack (displayException (exception :: SomeException)))

    errorStream envelopeJSVal failureMessage = do
        demandArrived <- jsPullEnvelopeAwaitDemand envelopeJSVal
        cancelled <- jsPullEnvelopeCancelled envelopeJSVal
        if cancelled || not demandArrived
            then jsPullEnvelopeCompletePull envelopeJSVal
            else do
                messageJSVal <- textToJSVal failureMessage
                jsPullEnvelopeError envelopeJSVal messageJSVal

    emitOneChunk envelopeJSVal chunkByteString = do
        demandArrived <- jsPullEnvelopeAwaitDemand envelopeJSVal
        cancelled <- jsPullEnvelopeCancelled envelopeJSVal
        if cancelled || not demandArrived
            then do
                jsPullEnvelopeCompletePull envelopeJSVal
                pure False
            else do
                jsPullEnvelopeRearm envelopeJSVal
                chunkJSVal <- byteStringToJSByteArray chunkByteString
                delivered <- jsPullEnvelopeEnqueue envelopeJSVal chunkJSVal
                jsPullEnvelopeCompletePull envelopeJSVal
                pure delivered

readableStreamGetReaderViaFFI :: JSVal -> IO JSVal
readableStreamGetReaderViaFFI = jsGetReader

readableStreamReaderReadViaFFI :: JSVal -> IO (Either Text (Maybe ByteString.ByteString))
readableStreamReaderReadViaFFI readerJSVal = do
    envelopeJSVal <- jsReaderReadEnveloped readerJSVal
    decodeEnveloped decodeReadResult envelopeJSVal
  where
    decodeReadResult readResultJSVal = do
        isDone <- jsReadResultDone readResultJSVal
        if isDone
            then pure Nothing
            else do
                chunkJSVal <- jsReadResultValue readResultJSVal
                Just <$> jsByteArrayToByteString chunkJSVal

foreign import javascript unsafe
    """
    (() => {
      const state = {
        cancelled: false
      };

      state.rearm = () => {
        state.demandPromise = new Promise((resolve) => {
          state.demandArrived = resolve;
        });
      };

      state.rearm();
      state.stream = new ReadableStream({
        start: (controller) => {
          state.controller = controller;
        },
        pull: () => {
          const pullCompleted = new Promise((resolve) => {
            state.pullComplete = resolve;
          });
          state.demandArrived();
          return pullCompleted;
        },
        cancel: () => {
          state.cancelled = true;
          state.demandArrived();
        }
      });

      return state;
    })()
    """
    jsMakePullEnvelope :: IO JSVal

foreign import javascript unsafe "$1.stream"
    jsPullEnvelopeStream :: JSVal -> IO JSVal

jsPullEnvelopeAwaitDemand :: JSVal -> IO Bool
jsPullEnvelopeAwaitDemand envelopeJSVal = do
    demandEnvelopeJSVal <- jsAwaitDemandEnveloped envelopeJSVal
    jsDemandEnvelopeDemandedField demandEnvelopeJSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.demandPromise;
        return {
          demanded: true
        };
      } catch {
        return {
          demanded: false
        };
      }
    })()
    """
    jsAwaitDemandEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.demanded === true"
    jsDemandEnvelopeDemandedField :: JSVal -> IO Bool

foreign import javascript unsafe "$1.rearm()"
    jsPullEnvelopeRearm :: JSVal -> IO ()

foreign import javascript unsafe "$1.cancelled === true"
    jsPullEnvelopeCancelled :: JSVal -> IO Bool

foreign import javascript unsafe
    """
    (() => {
      try {
        $1.controller.enqueue($2);
        return true;
      } catch {
        return false;
      }
    })()
    """
    jsPullEnvelopeEnqueue :: JSVal -> JSVal -> IO Bool

foreign import javascript unsafe "$1.pullComplete?.()"
    jsPullEnvelopeCompletePull :: JSVal -> IO ()

foreign import javascript unsafe
    """
    (() => {
      try {
        $1.controller.close();
      } catch {}
      $1.pullComplete?.();
    })()
    """
    jsPullEnvelopeClose :: JSVal -> IO ()

foreign import javascript unsafe
    """
    (() => {
      try {
        $1.controller.error(new Error($2));
      } finally {
        $1.pullComplete?.();
      }
    })()
    """
    jsPullEnvelopeError :: JSVal -> JSVal -> IO ()

-- Getting a reader can throw synchronously for an already locked stream.
-- Convert that failure before it can unwind the WASM reactor.
jsGetReader :: JSVal -> IO JSVal
jsGetReader stream = do
    envelope <- jsGetReaderEnveloped stream
    decodeEnveloped pure envelope >>= either (throwIO . StreamDrainFailure) pure

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.getReader() };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    })()
    """
    jsGetReaderEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.value ?? new Uint8Array(0)"
    jsReadResultValue :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.done === true"
    jsReadResultDone :: JSVal -> IO Bool

foreign import javascript safe
    """
    (async () => {
      try {
        const result = await $1.read();
        if (result === null || typeof result !== 'object') {
          throw new TypeError('the stream read() result is not an object');
        }
        const done = result.done;
        if (typeof done !== 'boolean') {
          throw new TypeError('the stream read() result done field is not a boolean: ' + typeof done);
        }
        // Read caller-owned getters inside the envelope boundary, before any
        // unsafe decoder runs. A completed read need not expose a value field.
        const value = done ? undefined : result.value;
        return { ok: true, value: { done, value } };
      } catch (error) {
        return {
          ok: false,
          message: String((error && error.message) || error)
        }
      }
    })()
    """
    jsReaderReadEnveloped :: JSVal -> IO JSVal

-- Native FixedLengthStream preserves a known byte count for R2.put. The reader
-- pump propagates source failures to the writable/readable. Explicit cancellation
-- through readableStreamCancelViaFFI also cancels and awaits the upstream reader:
-- the native readable's cancellation alone can leave an idle producer pending.
-- The pump observes failures and releases both reader and writer locks.
readableStreamWithLengthViaFFI :: Integer -> JSVal -> IO JSVal
readableStreamWithLengthViaFFI byteLength source
    | byteLength < 0 || byteLength > 9007199254740991 =
        throwIO (StreamDrainFailure "Invalid fixed stream byte length")
    | otherwise = do
        envelope <- jsFixedLengthStream (fromInteger byteLength) source
        decodeEnveloped pure envelope >>= either (throwIO . StreamDrainFailure) pure

foreign import javascript unsafe
    """
    (() => {
      try {
        if ($2.locked) {
          throw new TypeError('Cannot attach a fixed byte length to a locked stream');
        }
        const fixed = new FixedLengthStream($1);
        const reader = $2.getReader();
        const writer = fixed.writable.getWriter();
        // The pump observes operational failures below. Also observe the lock
        // lifecycle promises, which reject during deliberate cancellation.
        reader.closed.catch(() => {});
        writer.closed.catch(() => {});
        let stopping = false;
        let finished = false;
        const pipes = globalThis.__cloudflareWorkersHsFixedLengthPipes ??= new WeakMap();
        // Own the reader explicitly: native pipeTo can discard a producer's
        // rejected cancel promise when its destination is already cancelled.
        const completion = (async () => {
          try {
            while (true) {
              const chunk = await reader.read();
              if (stopping) {
                return;
              }
              if (chunk.done) {
                await writer.close();
                return;
              }
              await writer.write(chunk.value);
            }
          } catch (error) {
            await writer.abort(error).catch(() => {});
            await reader.cancel(error).catch(() => {});
          } finally {
            reader.releaseLock();
            writer.releaseLock();
            // Keep ownership after completion: R2 can retain the native
            // readable lock after a conditional put has returned null. The
            // WeakMap key does not keep a discarded readable alive.
            finished = true;
          }
        })();
        const cancel = async () => {
          if (finished) {
            return;
          }
          stopping = true;
          // A destination may be locked by R2 after a conditional put returns
          // null. Abort our writer as well as the upstream reader: cancelling
          // only the reader cannot release a pending backpressured write.
          const destinationCancellation = fixed.readable.locked
            ? Promise.resolve()
            : fixed.readable.cancel();
          const outcomes = await Promise.allSettled([
            reader.cancel(),
            writer.abort(new Error('Fixed length stream cancelled')),
            destinationCancellation,
          ]);
          await completion;
          if (outcomes[0].status === 'rejected') {
            throw outcomes[0].reason;
          }
          if (outcomes[2].status === 'rejected') {
            throw outcomes[2].reason;
          }
        };
        pipes.set(fixed.readable, { cancel });
        return { ok: true, value: fixed.readable };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    })()
    """
    jsFixedLengthStream :: Double -> JSVal -> IO JSVal

readableStreamCancelViaFFI :: JSVal -> IO ()
readableStreamCancelViaFFI source = do
    envelope <- jsCancelStream source
    outcome <- decodeEnveloped (const (pure ())) envelope
    either (throwIO . StreamDrainFailure) pure outcome

foreign import javascript safe
    """
    (async () => {
      try {
        const pipe = globalThis.__cloudflareWorkersHsFixedLengthPipes?.get($1);
        if (pipe) {
          // The pipe owns both locks and can terminate a native destination
          // even when its consumer still holds the readable lock.
          await pipe.cancel();
        } else {
          await $1.cancel();
        }
        return { ok: true, value: null };
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    })()
    """
    jsCancelStream :: JSVal -> IO JSVal

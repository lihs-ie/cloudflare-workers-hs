module Support.Runtime.SocketStream (socketProbe, streamProbe, producerProbe) where

import Cloudflare.Workers.Socket
import Cloudflare.Workers.Streaming qualified as Stream
import Cloudflare.Workers.Internal.FFI.Stream qualified as FFI
import Cloudflare.Workers.Internal.FFI.Bytes qualified as Bytes
import Data.ByteString qualified as Strict
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, throwIO, try, finally)
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as Lazy
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)

observe :: IO [Text.Text] -> IO JSVal
observe action = do
  result <- try action
  textToJSVal . Text.decodeUtf8 . Lazy.toStrict . Aeson.encode $
    either (\exception -> [Text.pack (displayException (exception :: SomeException))]) id result

shown :: Show a => a -> Text.Text
shown = Text.pack . show

socketProbe :: JSVal -> JSVal -> IO JSVal
socketProbe connector commandValue = observe $ do
  command <- jsValToText commandValue
  socket <- socketConnect (SocketConnector connector) (SocketAddressText "fixture:443")
    (SocketOptions SecureTransportStartTls True)
  let state = shown <$> socketState socket
      result :: Show a => IO a -> IO [Text.Text]
      result action = do
        outcome <- action
        current <- state
        pure [shown outcome, current]
  case command of
    "closed-success" -> do
      outcome <- socketClosed socket
      write <- socketWrite socket "later"
      finish <- socketFinishWrite socket
      current <- state
      pure [shown outcome, shown write, shown finish, current]
    "double-close" -> do
      first <- socketClose socket
      second <- socketClose socket
      current <- state
      pure [shown first, shown second, current]
    "half-open" -> do
      first <- socketFinishWrite socket
      bytes <- Stream.readableStreamToLazyByteString 32 (socketReadable socket)
      second <- socketFinishWrite socket
      pure [shown first, shown bytes, shown second]
    "tls-use" -> do
      upgraded <- socketStartTls socket >>= either throwIO pure
      write <- socketWrite upgraded "payload"
      finish <- socketFinishWrite upgraded
      oldWrite <- socketWrite socket "later"
      oldFinish <- socketFinishWrite socket
      pure [shown (socketOptions upgraded), shown write, shown finish, shown oldWrite, shown oldFinish,
        shown (socketIdentifier socket /= socketIdentifier upgraded)]
    "opened" -> result (socketOpened socket)
    "write" -> result (socketWrite socket "payload")
    "finish" -> result (socketFinishWrite socket)
    "closed" -> result (socketClosed socket)
    "close" -> do
      outcome <- socketClose socket
      write <- socketWrite socket "later"
      finish <- socketFinishWrite socket
      current <- state
      pure [shown outcome, shown write, shown finish, current]
    "tls-failure" -> do
      upgraded <- socketStartTls socket >>= either throwIO pure
      opened <- socketOpened upgraded
      closed <- socketClosed upgraded
      current <- socketState upgraded
      pure [shown opened, shown closed, shown current]
    "tls" -> do
      first <- socketStartTls socket
      firstState <- state
      second <- socketStartTls socket
      secondState <- state
      let tlsResult = either shown (shown . socketSecureTransport)
      pure [tlsResult first, firstState, tlsResult second, secondState]
    _ -> throwIO (userError "Unknown socket probe")

streamProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
streamProbe source commandValue lengthValue = observe $ do
  command <- jsValToText commandValue
  lengthText <- jsValToText lengthValue
  let byteLength = read (Text.unpack lengthText) :: Integer
  case command of
    "reader-eof" -> do
      reader <- FFI.readableStreamGetReaderViaFFI source
      first <- FFI.readableStreamReaderReadViaFFI reader
      second <- FFI.readableStreamReaderReadViaFFI reader
      pure [shown first, shown second]
    "bytes" -> do
      outcome <- Bytes.jsByteArrayToByteStringEither source
      pure [either id (shown . Strict.unpack) outcome]
    "bytes-throw" -> do
      value <- Bytes.jsByteArrayToByteString source
      pure [shown (Strict.unpack value)]
    "cancel" -> Stream.readableStreamCancel (Stream.readableStreamFromJSVal source) >> pure ["cancelled"]
    "fixed" -> do
      stream <- Stream.readableStreamWithLength byteLength (Stream.readableStreamFromJSVal source)
      outcome <- Stream.readableStreamToLazyByteString 32 stream
      pure [shown outcome]
    "fixed-cancel" -> do
      stream <- Stream.readableStreamWithLength byteLength (Stream.readableStreamFromJSVal source)
      Stream.readableStreamCancel stream
      pure ["cancelled"]
    "lazy" -> do
      outcome <- FFI.readableStreamToLazyByteString (fromInteger byteLength) source
      pure [shown outcome]
    _ -> throwIO (userError "Unknown stream probe")

producerProbe :: JSVal -> IO JSVal
producerProbe modeValue = do
  mode <- jsValToText modeValue
  completion <- jsProducerCompletion
  stream <- Stream.readableStreamFromProducer $ \emit -> (case mode of
    "failure" -> pure (Stream.StreamProducerFailed "producer-declared-failure")
    "throw" -> throwIO (userError "producer-thrown-failure")
    "cancel-failure" -> do
      awaitCancellation emit
      pure (Stream.StreamProducerFailed "producer-after-cancel")
    "cancel-throw" -> do
      awaitCancellation emit
      throwIO (userError "producer-after-cancel")
    _ -> do
      accepted <- emit "first"
      case accepted of
        Stream.StreamEmitCancelled -> pure Stream.StreamProducerCompleted
        Stream.StreamEmitAccepted -> do
          _ <- emit "second"
          pure Stream.StreamProducerCompleted) `finally` jsCompleteProducer completion
  let streamValue = Stream.readableStreamToJSVal stream
  jsAttachProducerCompletion streamValue completion
  pure streamValue

-- Keep producing until the consumer explicitly cancels; failure happens after
-- that observation, independent of the runtime's stream prefetch policy.
awaitCancellation :: (Strict.ByteString -> IO Stream.StreamEmitOutcome) -> IO ()
awaitCancellation emit = do
  outcome <- emit "first"
  case outcome of
    Stream.StreamEmitAccepted -> awaitCancellation emit
    Stream.StreamEmitCancelled -> pure ()

-- This notification means the user producer callback returned or threw, rather
-- than merely that native ReadableStream.cancel resolved.
foreign import javascript unsafe
  "(() => { let complete; const promise = new Promise(resolve => { complete = resolve; }); return { promise, complete }; })()"
  jsProducerCompletion :: IO JSVal

foreign import javascript unsafe "$1.complete()"
  jsCompleteProducer :: JSVal -> IO ()

foreign import javascript unsafe "$1.producerCompletion = $2.promise"
  jsAttachProducerCompletion :: JSVal -> JSVal -> IO ()

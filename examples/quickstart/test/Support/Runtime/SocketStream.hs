module Support.Runtime.SocketStream (socketProbe) where

import Cloudflare.Workers.Socket
import Cloudflare.Workers.Streaming qualified as Stream
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, throwIO, try)
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

-- | Native socket failure boundaries, excluded from production WASM exports.
module Support.SocketFailures (runSocketFailure) where

import Cloudflare.Workers.Socket
import Cloudflare.Workers.Streaming (readableStreamToLazyByteString)
import Control.Concurrent (forkIO, newEmptyMVar, putMVar, takeMVar)
import Control.Exception (bracket, throwIO)
import Control.Monad (void)
import Data.Aeson (Value, object, (.=))
import Data.Text (Text)

runSocketFailure :: SocketConnector -> Text -> Text -> IO Value
runSocketFailure connector scenario address = bracket
  (socketConnect connector (SocketAddressText address) socketDefaultOptions
    { socketOptionsSecureTransport = if scenario == "untrusted" then SecureTransportOn else SecureTransportOff })
  (void . socketClose)
  exercise
 where
  exercise socket
    | scenario == "untrusted" = do
        opened <- socketOpened socket
        closed <- socketClosed socket
        state <- socketState socket
        pure (object ["openedRejected" .= rejected opened, "closedRejected" .= rejected closed, "closedState" .= (state == SocketClosed)])
    | scenario == "close-race" = do
        either throwIO (const (pure ())) =<< socketOpened socket
        first <- newEmptyMVar
        second <- newEmptyMVar
        _ <- forkIO (socketClose socket >>= putMVar first)
        _ <- forkIO (socketClose socket >>= putMVar second)
        firstResult <- takeMVar first
        secondResult <- takeMVar second
        _ <- socketClosed socket
        state <- socketState socket
        late <- socketWrite socket "too late"
        pure (object ["bothCloseSucceeded" .= (not (rejected firstResult) && not (rejected secondResult))
          , "closedState" .= (state == SocketClosed), "lateWriteRejected" .= rejected late])
    | scenario == "peer-disconnect" = do
        either throwIO (const (pure ())) =<< socketOpened socket
        either throwIO pure =<< socketWrite socket "expected complete response\n"
        result <- readableStreamToLazyByteString 1024 (socketReadable socket)
        _ <- socketClosed socket
        state <- socketState socket
        pure (object ["partialBody" .= (result == Right "partial"), "closedState" .= (state == SocketClosed)])
    | otherwise = fail "Unknown socket failure fixture"
  rejected (Left _) = True
  rejected _ = False

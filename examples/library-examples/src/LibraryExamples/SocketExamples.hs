module LibraryExamples.SocketExamples (SocketEndpoints(..), socketEndpoints, socketTLSGreeting, socketStructuredGreeting) where

import Cloudflare.Workers.Socket
import Cloudflare.Workers.Streaming (readableStreamToLazyByteString)
import ExampleSupport.Interop (jsValToText)
import Control.Exception (bracket, throwIO)
import Control.Monad (void, when)
import Data.Aeson (Value, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text qualified as Text
import Text.Read (readMaybe)
import Data.Text.Encoding (decodeUtf8')
import GHC.Wasm.Prim (JSVal)

data SocketEndpoints = SocketEndpoints { tcpAddress :: Text, tlsAddress :: Text, startTlsAddress :: Text }

socketEndpoints :: JSVal -> IO SocketEndpoints
socketEndpoints env = SocketEndpoints <$> (getTCP env >>= jsValToText) <*> (getTLS env >>= jsValToText) <*> (getStartTLS env >>= jsValToText)
foreign import javascript unsafe "$1.TCP_ADDRESS || 'localhost:9099'" getTCP :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.TLS_ADDRESS || 'localhost:9100'" getTLS :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.STARTTLS_ADDRESS || 'localhost:9101'" getStartTLS :: JSVal -> IO JSVal

-- Only operator-provided endpoints are used. The runtime retains certificate
-- verification; tests add their own CA to the local runtime trust store.
socketTLSGreeting :: SocketConnector -> SecureTransport -> Text -> IO Value
socketTLSGreeting connector transport address = bracket
  (socketConnect connector (SocketAddressText address) socketDefaultOptions {socketOptionsSecureTransport = transport, socketOptionsAllowHalfOpen = True})
  (void . socketClose)
  (\initial -> do
    either throwIO (const (pure ())) =<< socketOpened initial
    if transport == SecureTransportStartTls
      then do
        -- The fixture accepts a line in cleartext before upgrading the same
        -- connection. No cleartext credentials or application payload are sent.
        either throwIO pure =<< socketWrite initial "STARTTLS\n"
        secure <- either throwIO pure =<< socketStartTls initial
        bracket (pure secure) (void . socketClose) $ \socket -> do
          previous <- socketState initial
          when (previous /= SocketClosed) (fail "StartTLS did not consume the original socket")
          secondUpgrade <- socketStartTls initial
          case secondUpgrade of Left _ -> pure (); Right _ -> fail "Second StartTLS upgrade succeeded"
          exchange socket True
      else exchange initial False)
 where
  exchange socket upgraded = do
    either throwIO (const (pure ())) =<< socketOpened socket
    either throwIO pure =<< socketWrite socket "library-tls\n"
    either throwIO pure =<< socketFinishWrite socket
    bytes <- either (fail . show) pure =<< readableStreamToLazyByteString 4096 (socketReadable socket)
    message <- either (fail . show) pure (decodeUtf8' (Lazy.toStrict bytes))
    either throwIO pure =<< socketClose socket
    pure (object ["message" .= message, "upgraded" .= upgraded, "secureTransport" .= show (socketSecureTransport socket)])

-- The endpoint comes from operator configuration, never from a request host.
-- The port smart constructor rejects invalid operator configuration before connect.
socketStructuredGreeting :: SocketConnector -> Text -> IO Value
socketStructuredGreeting connector address = do
  let (prefix, portText) = Text.breakOnEnd ":" address
      hostname = Text.dropEnd 1 prefix
  port <- case readMaybe (Text.unpack portText) >>= createSocketPort of
    Just valid | not (Text.null hostname) -> pure valid
    _ -> fail "Configured TCP endpoint must contain a hostname and valid port"
  bracket
    (socketConnect connector (SocketAddressRecord hostname port) socketDefaultOptions{socketOptionsAllowHalfOpen = True})
    (void . socketClose)
    (\socket -> do
      either throwIO (const (pure ())) =<< socketOpened socket
      either throwIO pure =<< socketWrite socket "library-examples\n"
      either throwIO pure =<< socketFinishWrite socket
      bytes <- either (fail . show) pure =<< readableStreamToLazyByteString 4096 (socketReadable socket)
      message <- either (fail . show) pure (decodeUtf8' (Lazy.toStrict bytes))
      -- Reading EOF does not settle the native closed promise on every local
      -- half-open transport. Close explicitly before awaiting final settlement.
      either throwIO pure =<< socketClose socket
      either throwIO pure =<< socketClosed socket
      state <- socketState socket
      pure (object ["message" .= message, "port" .= socketPortValue port, "state" .= show state]))

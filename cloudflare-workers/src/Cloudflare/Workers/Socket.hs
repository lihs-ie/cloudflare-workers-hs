module Cloudflare.Workers.Socket (
    SocketConnector (..),
    SocketConnectError (..),
    SocketPort,
    createSocketPort,
    socketPortValue,
    SocketAddress (..),
    SecureTransport (..),
    SocketOptions (..),
    socketDefaultOptions,
    SocketIdentifier (..),
    WritableStream,
    SocketState (..),
    Socket,
    socketIdentifier,
    socketReadable,
    socketWritable,
    socketSecureTransport,
    socketOptions,
    socketState,
    SocketInfo (..),
    SocketErrorKind (..),
    SocketError (..),
    classifySocketError,
    socketCanStartTls,
    socketConnect,
    socketOpened,
    socketWrite,
    socketFinishWrite,
    socketClosed,
    socketClose,
    socketStartTls,
) where

import Data.ByteString (ByteString)
import Control.Exception (Exception, throwIO)
import Data.IORef (IORef, atomicModifyIORef', newIORef, readIORef, writeIORef)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Socket (socketCloseViaFFI, socketClosedViaFFI, socketConnectViaFFI, socketOpenedViaFFI, socketStartTlsViaFFI, socketWriteViaFFI, socketFinishWriteViaFFI)
import Cloudflare.Workers.Streaming (ReadableStream, readableStreamFromJSVal)

newtype SocketConnector = SocketConnector JSVal

newtype SocketConnectError = SocketConnectError Text
    deriving stock (Show, Eq)

instance Exception SocketConnectError

newtype SocketPort = SocketPort Int
    deriving stock (Show, Eq)

createSocketPort :: Int -> Maybe SocketPort
createSocketPort port
    | port >= 1 && port <= 65535 = Just (SocketPort port)
    | otherwise = Nothing

socketPortValue :: SocketPort -> Int
socketPortValue (SocketPort port) = port

data SocketAddress = SocketAddressRecord Text SocketPort | SocketAddressText Text
    deriving stock (Show, Eq)

data SecureTransport = SecureTransportOff | SecureTransportOn | SecureTransportStartTls
    deriving stock (Show, Eq)

data SocketOptions = SocketOptions
    { socketOptionsSecureTransport :: SecureTransport
    , socketOptionsAllowHalfOpen :: Bool
    }
    deriving stock (Show, Eq)

socketDefaultOptions :: SocketOptions
socketDefaultOptions = SocketOptions SecureTransportOff False

newtype SocketIdentifier = SocketIdentifier Int
    deriving stock (Show, Eq)

newtype WritableStream = WritableStream JSVal

data SocketState = SocketReady | SocketStartTlsConsumed | SocketClosed
    deriving stock (Show, Eq)

data Socket = Socket
    { socketHandle :: JSVal
    , socketIdentifier :: SocketIdentifier
    , socketReadable :: ReadableStream
    , socketWritable :: WritableStream
    , socketSecureTransport :: SecureTransport
    , socketOptions :: SocketOptions
    , socketStateReference :: IORef SocketState
    }

socketState :: Socket -> IO SocketState
socketState = readIORef . socketStateReference

data SocketInfo = SocketInfo
    { socketInfoRemoteAddress :: Maybe Text
    , socketInfoLocalAddress :: Maybe Text
    }
    deriving stock (Show, Eq)

data SocketErrorKind = SocketConnectionError | SocketStreamError | SocketOtherError
    deriving stock (Show, Eq)

data SocketError = SocketError
    { socketErrorKind :: SocketErrorKind
    , socketErrorInformation :: Text
    }
    deriving stock (Show, Eq)

instance Exception SocketError

classifySocketError :: Text -> SocketError
classifySocketError information = SocketError kind information
  where
    lowered = Text.toLower information
    kind
        | any (`Text.isInfixOf` lowered) ["connect", "network", "dns", "refused"] = SocketConnectionError
        | any (`Text.isInfixOf` lowered) ["stream", "readable", "writable"] = SocketStreamError
        | otherwise = SocketOtherError

socketCanStartTls :: SecureTransport -> SocketState -> Bool
socketCanStartTls SecureTransportStartTls SocketReady = True
socketCanStartTls _ _ = False

socketConnect :: SocketConnector -> SocketAddress -> SocketOptions -> IO Socket
socketConnect (SocketConnector connectorJSVal) address options = do
    outcome <- socketConnectViaFFI connectorJSVal (toAddressViaFFI address) (secureTransportText (socketOptionsSecureTransport options)) (socketOptionsAllowHalfOpen options)
    either (throwIO . SocketConnectError) (makeSocket (socketOptionsSecureTransport options) options) outcome

-- | Write one chunk, awaiting backpressure before releasing the writer lock.
socketWrite :: Socket -> ByteString -> IO (Either SocketError ())
socketWrite socket bytes = do
    state <- socketState socket
    if state /= SocketReady
        then pure (Left (SocketError SocketStreamError "socket is not ready for writing"))
        else fmap (either (Left . classifySocketError) Right) (socketWriteViaFFI (socketHandle socket) bytes)

-- | Send EOF on the writable side while retaining the readable side.
socketFinishWrite :: Socket -> IO (Either SocketError ())
socketFinishWrite socket = do
    state <- socketState socket
    if state /= SocketReady
        then pure (Left (SocketError SocketStreamError "socket is not ready for writing"))
        else fmap (either (Left . classifySocketError) Right) (socketFinishWriteViaFFI (socketHandle socket))

socketOpened :: Socket -> IO (Either SocketError SocketInfo)
socketOpened socket = do
    outcome <- socketOpenedViaFFI (socketHandle socket)
    case outcome of
        Left information -> do
            writeIORef (socketStateReference socket) SocketClosed
            pure (Left (classifySocketError information))
        Right info -> pure (Right (uncurry SocketInfo info))

socketClosed :: Socket -> IO (Either SocketError ())
socketClosed socket = do
    outcome <- socketClosedViaFFI (socketHandle socket)
    writeIORef (socketStateReference socket) SocketClosed
    pure (either (Left . classifySocketError) Right outcome)

socketClose :: Socket -> IO (Either SocketError ())
socketClose socket = do
    outcome <- socketCloseViaFFI (socketHandle socket)
    case outcome of
        Left information -> pure (Left (classifySocketError information))
        Right () -> writeIORef (socketStateReference socket) SocketClosed >> pure (Right ())

socketStartTls :: Socket -> IO (Either SocketError Socket)
socketStartTls socket = do
    previousState <- atomicModifyIORef' (socketStateReference socket) consumeStartTls
    case previousState of
        Nothing -> pure (Left (SocketError SocketOtherError "startTls is only available once on a ready starttls socket"))
        Just _ -> do
            outcome <- socketStartTlsViaFFI (socketHandle socket)
            case outcome of
                Left information -> writeIORef (socketStateReference socket) SocketReady >> pure (Left (classifySocketError information))
                Right rawSocket -> do
                    writeIORef (socketStateReference socket) SocketClosed
                    let tlsOptions = (socketOptions socket){socketOptionsSecureTransport = SecureTransportOn}
                    Right <$> makeSocket SecureTransportOn tlsOptions rawSocket
  where
    consumeStartTls state
        | socketCanStartTls (socketSecureTransport socket) state = (SocketStartTlsConsumed, Just state)
        | otherwise = (state, Nothing)

makeSocket :: SecureTransport -> SocketOptions -> (JSVal, Int, JSVal, JSVal) -> IO Socket
makeSocket secureTransport options (handle, identifierValue, readableJSVal, writableJSVal) = do
    stateReference <- newIORef SocketReady
    pure Socket{socketHandle = handle, socketIdentifier = SocketIdentifier identifierValue, socketReadable = readableStreamFromJSVal readableJSVal, socketWritable = WritableStream writableJSVal, socketSecureTransport = secureTransport, socketOptions = options, socketStateReference = stateReference}

toAddressViaFFI :: SocketAddress -> Either Text (Text, Int)
toAddressViaFFI (SocketAddressText value) = Left value
toAddressViaFFI (SocketAddressRecord hostname port) = Right (hostname, socketPortValue port)

secureTransportText :: SecureTransport -> Text
secureTransportText SecureTransportOff = "off"
secureTransportText SecureTransportOn = "on"
secureTransportText SecureTransportStartTls = "starttls"

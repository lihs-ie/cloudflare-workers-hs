{-# LANGUAGE MultilineStrings #-}

module Support.Runtime.TransportExtra (transportExtraProbe) where

import Cloudflare.Workers.HTTP
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Cloudflare.Workers.Socket (createSocketPort, socketPortValue)
import Cloudflare.Workers.Socket qualified as Socket
import Cloudflare.Workers.Streaming
import Control.Exception (SomeException, displayException, throwIO, try)
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as Lazy
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)

shown :: Show a => a -> Text.Text
shown = Text.pack . show

transportExtraProbe :: JSVal -> JSVal -> IO JSVal
transportExtraProbe source commandValue = do
    command <- jsValToText commandValue
    outcome <- try $ case command of
        "diagnostic-contracts" -> diagnosticContracts
        "socket-metadata" -> do
            socket <- Socket.socketConnect (Socket.SocketConnector source)
                (Socket.SocketAddressText "fixture:443") Socket.socketDefaultOptions
            info <- Socket.socketOpened socket >>= either throwIO pure
            pure [shown (Socket.socketInfoRemoteAddress info), shown (Socket.socketInfoLocalAddress info)]
        "socket-typed-error" -> do
            socket <- Socket.socketConnect (Socket.SocketConnector source)
                (Socket.SocketAddressText "fixture:443") Socket.socketDefaultOptions
            result <- try (Socket.socketWrite socket "payload" >>= either throwIO pure)
                :: IO (Either Socket.SocketError ())
            case result of
                Left failure -> pure [shown (Socket.socketErrorKind failure), Socket.socketErrorInformation failure,
                    shown (failure == Socket.classifySocketError "Error: writable failure"), Text.pack (displayException failure)]
                Right () -> pure ["write succeeded"]
        "socket-connect-error" -> do
            result <- try (Socket.socketConnect (Socket.SocketConnector source)
                (Socket.SocketAddressText "fixture:443") Socket.socketDefaultOptions)
                :: IO (Either Socket.SocketConnectError Socket.Socket)
            case result of
                Left failure -> pure [Text.pack (displayException failure)]
                Right socket -> pure [shown (Socket.socketOptions socket)]
        "methods" -> pure [methodToText (methodFromText method) |
            method <- ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "PROPFIND", "patch"]]
        "ports" -> pure [shown (socketPortValue <$> createSocketPort port) | port <- [-1, 0, 1, 65535, 65536]]
        "unicode" -> (:[]) <$> jsValToText source
        _ -> throwIO (userError "Unknown transport probe")
    textToJSVal . Text.decodeUtf8 . Lazy.toStrict . Aeson.encode $
        either (\failure -> [Text.pack (displayException (failure :: SomeException))]) id outcome


-- Consumers collect diagnostics and compare snapshots to distinguish changed
-- payloads from an unchanged observation. Cross-check Show's entry points and
-- the full equality/inequality matrix, including a repeated observation.
diagnosticContract :: (Eq a, Show a) => Text.Text -> [a] -> Text.Text
diagnosticContract name samples = Text.decodeUtf8 . Lazy.toStrict . Aeson.encode $
    Aeson.object
        [ "name" Aeson..= name
        , "diagnostics" Aeson..= map show observations
        , "collection" Aeson..= show observations
        , "showListConsistent" Aeson..= (showList observations "tail" == show observations <> "tail")
        , "showsPrecConsistent" Aeson..= all (\value -> showsPrec 0 value "tail" == show value <> "tail") observations
        , "equality" Aeson..= [[left == right | right <- observations] | left <- observations]
        , "inequality" Aeson..= [[left /= right | right <- observations] | left <- observations]
        ]
  where
    observations = samples <> take 1 samples

diagnosticContracts :: IO [Text.Text]
diagnosticContracts = do
    port <- maybe (throwIO (userError "Invalid diagnostic fixture port")) pure (Socket.createSocketPort 443)
    otherPort <- maybe (throwIO (userError "Invalid diagnostic fixture port")) pure (Socket.createSocketPort 8443)
    pure
        [ diagnosticContract "http-method" [GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS, OtherMethod "PROPFIND", OtherMethod "CUSTOM"]
        , diagnosticContract "http-status" [Status 200, Status 404]
        , diagnosticContract "http-body-placeholder" [RequestBodyPlaceholder "first", RequestBodyPlaceholder "second"]
        , diagnosticContract "socket-connect-exception" [Socket.SocketConnectError "first", Socket.SocketConnectError "second"]
        , diagnosticContract "socket-port" [port, otherPort]
        , diagnosticContract "socket-address" [Socket.SocketAddressText "first:443", Socket.SocketAddressText "second:443",
            Socket.SocketAddressRecord "first" port, Socket.SocketAddressRecord "first" otherPort,
            Socket.SocketAddressRecord "second" port]
        , diagnosticContract "socket-security" [Socket.SecureTransportOff, Socket.SecureTransportOn, Socket.SecureTransportStartTls]
        , diagnosticContract "socket-options" [Socket.SocketOptions Socket.SecureTransportOff False,
            Socket.SocketOptions Socket.SecureTransportOff True, Socket.SocketOptions Socket.SecureTransportOn False]
        , diagnosticContract "socket-identifier" [Socket.SocketIdentifier 1, Socket.SocketIdentifier 2]
        , diagnosticContract "socket-state" [Socket.SocketReady, Socket.SocketStartTlsConsumed, Socket.SocketClosed]
        , diagnosticContract "socket-info" [Socket.SocketInfo Nothing Nothing, Socket.SocketInfo (Just "remote") Nothing,
            Socket.SocketInfo Nothing (Just "local"), Socket.SocketInfo (Just "other") Nothing,
            Socket.SocketInfo Nothing (Just "other")]
        , diagnosticContract "socket-error-kind" [Socket.SocketConnectionError, Socket.SocketStreamError, Socket.SocketOtherError]
        , diagnosticContract "socket-error" [Socket.SocketError Socket.SocketConnectionError "first",
            Socket.SocketError Socket.SocketConnectionError "second", Socket.SocketError Socket.SocketStreamError "first"]
        , diagnosticContract "read-error" [ReadableStreamExceededByteLimit, ReadableStreamStalled]
        , diagnosticContract "emit-outcome" [StreamEmitAccepted, StreamEmitCancelled]
        , diagnosticContract "producer-outcome" [StreamProducerCompleted, StreamProducerFailed "first", StreamProducerFailed "second"]
        ]

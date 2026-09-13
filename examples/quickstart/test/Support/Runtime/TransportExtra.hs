{-# LANGUAGE MultilineStrings #-}

module Support.Runtime.TransportExtra (transportExtraProbe, transportRequestExtra, transportResponseExtra) where

import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList, headersToList)
import Cloudflare.Workers.Internal.FFI.Bytes qualified as Bytes
import Cloudflare.Workers.Internal.FFI.Headers qualified as HeadersFFI
import Cloudflare.Workers.Internal.FFI.Request qualified as RequestFFI
import Cloudflare.Workers.Internal.FFI.Response qualified as ResponseFFI
import Cloudflare.Workers.Internal.FFI.Stream qualified as StreamFFI
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Internal.FFI.Text qualified as TextFFI
import Cloudflare.Workers.Socket (createSocketPort, socketPortValue)
import Cloudflare.Workers.Socket qualified as Socket
import Cloudflare.Workers.Internal.FFI.Socket qualified as SocketFFI
import Cloudflare.Workers.Streaming
import Cloudflare.Workers.URL (parseURL)
import Control.Exception (SomeException, displayException, throwIO, try)
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as Lazy
import Data.Maybe (isJust)
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
        "typed-byte-drain" -> do
            result <- try (StreamFFI.readableStreamToLazyByteString 32 source)
                :: IO (Either Bytes.JSByteArrayReadError (Maybe Lazy.ByteString))
            case result of
                Left failure -> pure [shown (failure == Bytes.JSByteArrayReadError
                    (Bytes.describeJSByteArrayRejection Bytes.JSByteArrayNotAView)),
                    Text.pack (displayException failure)]
                Right bytes -> pure [shown bytes]
        "typed-stream-drain" -> do
            result <- try (StreamFFI.readableStreamToLazyByteString 32 source)
                :: IO (Either StreamFFI.StreamDrainFailure (Maybe Lazy.ByteString))
            case result of
                Left failure -> pure [shown (failure == StreamFFI.StreamDrainFailure "read failure"),
                    Text.pack (displayException failure)]
                Right bytes -> pure [shown bytes]
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
        "socket-native-writable" -> do
            (_, _, _, writable) <- SocketFFI.socketConnectViaFFI source (Left "fixture:443") "off" False
                >>= either (throwIO . userError . Text.unpack) pure
            (:[]) <$> (writeNativeSocket writable >>= jsValToText)
        "steps" -> pure [shown (StreamFFI.streamDrainStepDecision total limit chunk) |
            (total, limit, chunk) <- [(0, 10, 0), (0, 10, -1), (8, 10, 3), (8, 10, 2),
                (0, 10, 1), (toInteger (maxBound :: Int), maxBound, 1)]]
        "methods" -> pure [methodToText (methodFromText method) |
            method <- ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "PROPFIND", "patch"]]
        "byte-codes" -> pure [either Bytes.describeJSByteArrayRejection shown (Bytes.classifyJSByteArrayLengthCode code) |
            code <- [-4, -99, 0, 17]]
        "header-decode" -> do
            headers <- HeadersFFI.headersFromJSVal source
            pure [shown (headersToList headers)]
        "header-name" -> do
            _ <- HeadersFFI.headersToJSVal (headersFromList [("invalid name", "value")])
            pure ["unexpected success"]
        "header-value" -> do
            _ <- HeadersFFI.headersToJSVal (headersFromList [("x-value", "line\r\nnext")])
            pure ["unexpected success"]
        "ports" -> pure [shown (socketPortValue <$> createSocketPort port) | port <- [-1, 0, 1, 65535, 65536]]
        "unicode" -> (:[]) <$> jsValToText source
        "invalid-upgrade" -> transportResponseExtra source commandValue >> pure ["unexpected success"]
        "metadata" -> do
            method <- RequestFFI.requestMethodText source
            body <- RequestFFI.requestBodyJSVal source
            colo <- RequestFFI.requestDataCenterText source
            pure [method, shown (isJust body), shown colo]
        "reader-limit" -> transportRequestExtra source commandValue >> pure ["unexpected success"]
        "reader-stalled" -> transportRequestExtra source commandValue >> pure ["unexpected success"]
        _ -> throwIO (userError "Unknown transport probe")
    textToJSVal . Text.decodeUtf8 . Lazy.toStrict . Aeson.encode $
        either (\failure -> [Text.pack (displayException (failure :: SomeException))]) id outcome

transportRequestExtra :: JSVal -> JSVal -> IO JSVal
transportRequestExtra source commandValue = do
    command <- jsValToText commandValue
    url <- maybe (throwIO (userError "Invalid fixture URL")) pure (parseURL "https://transport.example/path?q=1")
    let stream = if command == "stream" then Just (readableStreamFromJSVal source) else Nothing
        reader = case command of
            "reader" -> Just (\_ -> pure (Right "reader bytes"))
            "reader-budget" -> Just (pure . Right . Lazy.fromStrict . Text.encodeUtf8 . shown)
            "reader-limit" -> Just (\_ -> pure (Left ReadableStreamExceededByteLimit))
            "reader-stalled" -> Just (\_ -> pure (Left ReadableStreamStalled))
            _ -> Nothing
        method = if command == "empty" then GET else PATCH
    RequestFFI.requestToJSVal (Request method url stream (headersFromList [("x-transport", "present")]) reader Nothing)

transportResponseExtra :: JSVal -> JSVal -> IO JSVal
transportResponseExtra source commandValue = do
    command <- jsValToText commandValue
    body <- case command of
        "fixed" -> ResponseBodyStream <$> readableStreamWithLength 10 (readableStreamFromJSVal source)
        "lazy" -> pure (ResponseBodyLazyBytes (Lazy.fromChunks ["first", "second"]))
        "stream" -> pure (ResponseBodyStream (readableStreamFromJSVal source))
        "invalid-upgrade" -> pure (ResponseBodyWebSocket (PassthroughResponse source))
        "passthrough" -> pure (ResponseBodyPassthrough (PassthroughResponse source))
        _ -> throwIO (userError "Unknown response probe")
    ResponseFFI.responsetoJSVal (createResponse (Status 202) (headersFromList [("x-transport", "present")]) body)

-- A low-level FFI consumer can use the returned native writable directly.
foreign import javascript safe
    """
    (async () => {
      const writer = $1.getWriter();
      try {
        await writer.write(new Uint8Array([110, 97, 116, 105, 118, 101]));
        await writer.close();
        return 'written and closed';
      } catch (error) {
        return String(error);
      } finally {
        writer.releaseLock();
      }
    })()
    """
    writeNativeSocket :: JSVal -> IO JSVal

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
        , "showsPrecConsistent" Aeson..= all (\value -> shows value "tail" == show value <> "tail") observations
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
        , diagnosticContract "byte-rejection" [Bytes.JSByteArrayNotAView, Bytes.JSByteArrayWrongElementWidth,
            Bytes.JSByteArrayLengthUnrepresentable, Bytes.JSByteArrayUnknownRejection (-4), Bytes.JSByteArrayUnknownRejection (-5)]
        , diagnosticContract "byte-exception" [Bytes.JSByteArrayReadError "first", Bytes.JSByteArrayReadError "second"]
        , diagnosticContract "stream-step" [StreamFFI.StreamDrainContinue 1, StreamFFI.StreamDrainContinue 2,
            StreamFFI.StreamDrainStopByteLimitExceeded, StreamFFI.StreamDrainStopStalled]
        , diagnosticContract "stream-outcome" [StreamFFI.StreamDrainCompleted "a", StreamFFI.StreamDrainCompleted "b",
            StreamFFI.StreamDrainByteLimitExceeded, StreamFFI.StreamDrainStalled, StreamFFI.StreamDrainFailed "first",
            StreamFFI.StreamDrainFailed "second"]
        , diagnosticContract "stream-exception" [StreamFFI.StreamDrainFailure "first", StreamFFI.StreamDrainFailure "second"]
        , diagnosticContract "string-kind" [TextFFI.JSStringKindUndefined, TextFFI.JSStringKindNull,
            TextFFI.JSStringKindString, TextFFI.JSStringKindOther]
        , diagnosticContract "string-outcome" [TextFFI.JSStringAbsent, TextFFI.JSStringNull,
            TextFFI.JSStringNotAString "number", TextFFI.JSStringNotAString "object",
            TextFFI.JSStringPresent "first", TextFFI.JSStringPresent "second"]
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

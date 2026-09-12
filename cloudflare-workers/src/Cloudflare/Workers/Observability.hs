{-# LANGUAGE CPP #-}

module Cloudflare.Workers.Observability (
    tailLog,
    waitUntilOn,
    LogLevel (..),
    LogRecord (..),
    LoggerConfig (..),
    defaultLoggerConfig,
    shouldEmitLog,
    emitLog,
    LogSink,
    deferredSink,
    deferredSinkExceptErrors,
    isDeferrableLogLevel,
) where

import Control.Exception (SomeException, try)
import Control.Monad (when)
import Data.Aeson (ToJSON (toJSON), Value (String), object, (.=))
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Maybe (catMaybes)
import Data.Text (Text)
import Data.Text.Encoding qualified as TextEncoding

import Cloudflare.Workers.Reactor (WorkersExecutionContext, waitUntil)

#if defined(wasm32_HOST_ARCH)
import Cloudflare.Workers.Internal.FFI.Reactor (emitLogViaFFI, logRandomViaFFI, tailLogViaFFI)
#else
import qualified Data.Text.IO as TextIO
import System.IO (stderr)
import System.Random (randomRIO)
#endif

data LogLevel
    = LogDebug
    | LogInfo
    | LogWarn
    | LogError
    deriving stock (Show, Eq, Ord)

instance ToJSON LogLevel where
    toJSON LogDebug = String "debug"
    toJSON LogInfo = String "info"
    toJSON LogWarn = String "warn"
    toJSON LogError = String "error"

data LogRecord = LogRecord
    { logRecordLevel :: LogLevel
    , logRecordRequestId :: Text
    , logRecordRayId :: Maybe Text
    , logRecordMethod :: Maybe Text
    , logRecordPath :: Maybe Text
    , logRecordStatus :: Maybe Int
    , logRecordDurationMs :: Maybe Double
    , logRecordErrorKind :: Maybe Text
    , logRecordMessage :: Text
    }
    deriving (Show, Eq)

instance ToJSON LogRecord where
    toJSON record =
        object
            ( catMaybes
                [ Just ("level" .= logRecordLevel record)
                , Just ("request_id" .= logRecordRequestId record)
                , ("ray_id" .=) <$> logRecordRayId record
                , ("method" .=) <$> logRecordMethod record
                , ("path" .=) <$> logRecordPath record
                , ("status" .=) <$> logRecordStatus record
                , ("duration_ms" .=) <$> logRecordDurationMs record
                , ("error_kind" .=) <$> logRecordErrorKind record
                , Just ("message" .= logRecordMessage record)
                ]
            )

data LoggerConfig = LoggerConfig
    { loggerConfigMinLevel :: LogLevel
    , loggerConfigSampleRate :: Double
    }
    deriving stock (Show, Eq)

defaultLoggerConfig :: LoggerConfig
defaultLoggerConfig =
    LoggerConfig
        { loggerConfigMinLevel = LogInfo
        , loggerConfigSampleRate = 1.0
        }

shouldEmitLog :: LoggerConfig -> LogLevel -> Double -> Bool
shouldEmitLog config level randomValue =
    level >= loggerConfigMinLevel config
        && (level == LogError || randomValue < loggerConfigSampleRate config)

logRecordToJSONText :: LogRecord -> Text
logRecordToJSONText = TextEncoding.decodeUtf8 . LazyByteString.toStrict . Aeson.encode

emitLog :: LoggerConfig -> LogRecord -> IO ()
#if defined(wasm32_HOST_ARCH)
emitLog config record = do
  randomValue <- logRandomViaFFI
  when (shouldEmitLog config (logRecordLevel record) randomValue) $
    emitLogViaFFI (logRecordToJSONText record)
#else
emitLog config record = do
  randomValue <- randomRIO (0, 1)
  when (shouldEmitLog config (logRecordLevel record) randomValue) $
    TextIO.hPutStrLn stderr (logRecordToJSONText record)
#endif

type LogSink = LogRecord -> IO ()

deferredSink :: WorkersExecutionContext -> LogSink -> LogSink
deferredSink context sink record = do
    registrationOutcome <- try (waitUntilOn context (sink record))
    case registrationOutcome of
        Right () -> pure ()
        Left (_ :: SomeException) -> sink record

isDeferrableLogLevel :: LogLevel -> Bool
isDeferrableLogLevel LogDebug = True
isDeferrableLogLevel LogInfo = True
isDeferrableLogLevel LogWarn = True
isDeferrableLogLevel LogError = False

deferredSinkExceptErrors :: WorkersExecutionContext -> LogSink -> LogSink
deferredSinkExceptErrors ctx sink record =
    if isDeferrableLogLevel (logRecordLevel record)
        then deferredSink ctx sink record
        else sink record

tailLog :: Text -> IO ()
#if defined(wasm32_HOST_ARCH)
tailLog = tailLogViaFFI
#else
tailLog = TextIO.hPutStrLn stderr
#endif

waitUntilOn :: WorkersExecutionContext -> IO () -> IO ()
waitUntilOn = waitUntil

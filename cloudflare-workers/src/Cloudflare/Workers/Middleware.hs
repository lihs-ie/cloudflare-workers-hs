{-# LANGUAGE CPP #-}

module Cloudflare.Workers.Middleware (
  Middleware,
  requestIdHeaderName,
  withRequestId,
  withStructuredLogging,
  withStructuredLoggingUsing,
  generateRequestId,
  formatRequestIdentifierUUIDv4,
  currentMillis,
) where

import Control.Exception (SomeException, displayException, throwIO, try)
import Data.Bits ((.&.), (.|.))
import Data.List (intercalate)
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Word (Word64)
import Numeric (showHex)

import Cloudflare.Workers.Entrypoint.Fetch (FetchHandler)
import Cloudflare.Workers.HTTP (
  Request (requestHeaders),
  Response (responseStatus),
  Status (statusCode),
  methodToText,
  requestMethod,
  requestPath,
 )
import Cloudflare.Workers.Headers (headerInsert, headerLookup)
import Cloudflare.Workers.Observability (
  LogLevel (LogError, LogInfo),
  LogRecord (LogRecord),
  LogSink,
  LoggerConfig,
  deferredSinkExceptErrors,
  emitLog,
 )

#if defined(wasm32_HOST_ARCH)
import Cloudflare.Workers.Internal.FFI.Reactor (dateNowMillisViaFFI, randomUUIDViaFFI)
#else
import Data.Time.Clock.POSIX (getPOSIXTime)
import System.Random (randomIO)
#endif

type Middleware env = FetchHandler env -> FetchHandler env

requestIdHeaderName :: Text
requestIdHeaderName = "x-hs-request-id"

withRequestId :: Middleware env
withRequestId handler request env ctx = do
  requestId <- resolveRequestId request
  let requestWithId = request {requestHeaders = headerInsert requestIdHeaderName requestId (requestHeaders request)}
  handler requestWithId env ctx

resolveRequestId :: Request -> IO Text
resolveRequestId request = maybe generateRequestId pure (headerLookup "cf-ray" (requestHeaders request))

generateRequestId :: IO Text
#if defined(wasm32_HOST_ARCH)
generateRequestId = randomUUIDViaFFI
#else
generateRequestId = do
  highWord <- randomIO
  formatRequestIdentifierUUIDv4 highWord <$> randomIO
#endif

formatRequestIdentifierUUIDv4 :: Word64 -> Word64 -> Text
formatRequestIdentifierUUIDv4 highWord lowWord =
  Text.pack
    ( intercalate
        "-"
        [ take 8 highHex
        , take 4 (drop 8 highHex)
        , take 4 (drop 12 highHex)
        , take 4 lowHex
        , drop 4 lowHex
        ]
    )
  where
    versionedHighWord = (highWord .&. 0xFFFFFFFFFFFF0FFF) .|. 0x0000000000004000
    variantedLowWord = (lowWord .&. 0x3FFFFFFFFFFFFFFF) .|. 0x8000000000000000
    highHex = hex16 versionedHighWord
    lowHex = hex16 variantedLowWord
    hex16 word64 =
      let digits = showHex word64 ""
       in replicate (16 - length digits) '0' ++ digits

withStructuredLogging :: LoggerConfig -> Middleware env
withStructuredLogging config = withStructuredLoggingUsing (emitLog config)

withStructuredLoggingUsing :: LogSink -> Middleware env
withStructuredLoggingUsing sink handler request env ctx = do
  let requestId = requestIdFrom request
      rayId = rayIdFrom request
      method = Just (methodToText (requestMethod request))
      path = Just (requestPath request)
      emit = deferredSinkExceptErrors ctx sink
  startMillis <- currentMillis
  emit (LogRecord LogInfo requestId rayId method path Nothing Nothing Nothing "request started")
  outcome <- try (handler request env ctx)
  case outcome of
    Right response -> do
      endMillis <- currentMillis
      emit
        ( LogRecord
            LogInfo
            requestId
            rayId
            method
            path
            (Just (statusCode (responseStatus response)))
            (Just (endMillis - startMillis))
            Nothing
            "request completed"
        )
      pure response
    Left (exception :: SomeException) -> do
      endMillis <- currentMillis
      emit
        ( LogRecord
            LogError
            requestId
            rayId
            method
            path
            Nothing
            (Just (endMillis - startMillis))
            (Just "SomeException")
            (Text.pack (displayException exception))
        )
      throwIO exception

requestIdFrom :: Request -> Text
requestIdFrom request = fromMaybe "unknown" (headerLookup requestIdHeaderName (requestHeaders request))

rayIdFrom :: Request -> Maybe Text
rayIdFrom request = headerLookup "cf-ray" (requestHeaders request)

currentMillis :: IO Double
#if defined(wasm32_HOST_ARCH)
currentMillis = dateNowMillisViaFFI
#else
currentMillis = do
  epochSeconds <- getPOSIXTime
  pure (fromIntegral (floor (realToFrac epochSeconds * 1000 :: Double) :: Integer))
#endif

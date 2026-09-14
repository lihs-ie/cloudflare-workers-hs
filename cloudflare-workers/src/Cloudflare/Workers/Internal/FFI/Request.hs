module Cloudflare.Workers.Internal.FFI.Request (
    requestMethodText,
    requestHeadersJSVal,
    requestBodyJSVal,
    requestDataCenterText,
    requestToJSVal,
) where

import Cloudflare.Workers.HTTP (Request (requestHeaders), methodToText, requestBody, requestBodyReader, requestMethod, requestURL)
import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray)
import Cloudflare.Workers.Internal.FFI.Headers (headersToJSVal)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Internal.Streaming (readableStreamToJSVal)
import Cloudflare.Workers.Streaming (ReadableStreamReadError (ReadableStreamExceededByteLimit, ReadableStreamReadFailed, ReadableStreamStalled))
import Cloudflare.Workers.URL (urlText)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import Data.Text qualified as Text
import Control.Exception (throwIO)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import GHC.Wasm.Prim (JSVal)

requestMethodText :: JSVal -> IO Text
requestMethodText requestJSValue = jsRequestMethod requestJSValue >>= jsValToText

foreign import javascript "$1.method"
    jsRequestMethod :: JSVal -> IO JSVal

requestHeadersJSVal :: JSVal -> IO JSVal
requestHeadersJSVal = jsRequestHeaders

foreign import javascript unsafe "$1.headers"
    jsRequestHeaders :: JSVal -> IO JSVal

requestBodyJSVal :: JSVal -> IO (Maybe JSVal)
requestBodyJSVal requestJSValue = do
    hasBody <- jsHasRequestBody requestJSValue
    if hasBody
        then pure Nothing
        else Just <$> jsRequestBody requestJSValue

foreign import javascript unsafe "$1.body === null"
    jsHasRequestBody :: JSVal -> IO Bool

foreign import javascript unsafe "$1.body"
    jsRequestBody :: JSVal -> IO JSVal

requestDataCenterText :: JSVal -> IO (Maybe Text)
requestDataCenterText requestJSValue = do
    hasDataCenter <- jsRequestDataHasDataCenter requestJSValue
    if hasDataCenter
        then Just <$> (jsRequestDataCenter requestJSValue >>= jsValToText)
        else pure Nothing

requestToJSVal :: Request -> IO JSVal
requestToJSVal request = do
    urlJSVal <- textToJSVal (urlText url)
    methodJSVal <- textToJSVal (methodToText (requestMethod request))
    headersJSVal <- headersToJSVal (requestHeaders request)
    bodyJSVal <- case requestBody request of
        Just bodyStream -> pure (readableStreamToJSVal bodyStream)
        Nothing -> case requestBodyReader request of
            Nothing -> jsUndefinedValue
            Just readBody -> do
                drained <- readBody maxBound
                case drained of
                    Right lazyBytes -> byteStringToJSByteArray (LazyByteString.toStrict lazyBytes)
                    Left ReadableStreamExceededByteLimit ->
                        error "requestToJSVal: request body exceeded the representable byte limit"
                    Left ReadableStreamStalled ->
                        error "requestToJSVal: the request body stream stalled (a chunk carrying no bytes)"
                    Left (ReadableStreamReadFailed message) ->
                        error ("requestToJSVal: request body read failed: " <> Text.unpack message)
    envelope <- jsNewRequest urlJSVal methodJSVal headersJSVal bodyJSVal
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome
  where
    url = requestURL request

foreign import javascript unsafe "typeof $1.cf?.colo === 'string'"
    jsRequestDataHasDataCenter :: JSVal -> IO Bool

foreign import javascript unsafe "$1.cf.colo"
    jsRequestDataCenter :: JSVal -> IO JSVal

foreign import javascript unsafe "undefined"
    jsUndefinedValue :: IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
      const init = { method: $2, headers: $3 };
      if ($4 !== undefined) {
        init.body = $4;
        if ($4 instanceof ReadableStream) {
          init.duplex = "half";
        }
      }
      return { ok: true, value: new Request($1, init) };
      } catch (_) {
        return { ok: false, message: "Failed to construct the native Request" };
      }
    })()
    """
    jsNewRequest :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

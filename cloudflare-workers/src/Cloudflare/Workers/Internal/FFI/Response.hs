module Cloudflare.Workers.Internal.FFI.Response (
    responsetoJSVal,
) where

import Cloudflare.Workers.HTTP (
    PassthroughResponse (PassthroughResponse),
    Response (responseBody, responseHeaders, responseStatus),
    ResponseBody (..),
    Status (statusCode),
 )
import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray)
import Cloudflare.Workers.Internal.FFI.Headers (headersToJSVal)
import Cloudflare.Workers.Streaming (readableStreamToJSVal)
import Control.Exception (throwIO)
import Data.ByteString.Lazy qualified as LazyByteString
import GHC.Wasm.Prim (JSVal)

responsetoJSVal :: Response -> IO JSVal
responsetoJSVal response = do
    headersJSValue <- headersToJSVal (responseHeaders response)
    let responseStatusCode = statusCode (responseStatus response)
    case responseBody response of
        ResponseBodyBytes byteString -> do
            bodyJSValue <- byteStringToJSByteArray byteString
            jsNewResponseFromBytes bodyJSValue responseStatusCode headersJSValue
        ResponseBodyLazyBytes lazyByteString -> do
            bodyJSValue <- byteStringToJSByteArray (LazyByteString.toStrict lazyByteString)
            jsNewResponseFromBytes bodyJSValue responseStatusCode headersJSValue
        ResponseBodyStream readableStream -> jsNewResponseFromBytes (readableStreamToJSVal readableStream) responseStatusCode headersJSValue
        ResponseBodyWebSocket (PassthroughResponse upgrade)
            | responseStatusCode == 101 -> jsUpgradeResponse upgrade headersJSValue
            | otherwise -> throwIO (userError "WebSocket response status must remain 101")
        ResponseBodyPassthrough (PassthroughResponse passthroughJSValue) ->
            jsNewResponseFromPassthroughBody passthroughJSValue responseStatusCode headersJSValue

-- Fetch requires a null body for these statuses, even when the byte array is
-- empty. Normalize only empty bytes: non-empty data and opaque streams still
-- reach the native constructor so invalid responses fail visibly.
foreign import javascript unsafe
    "new Response(([204, 205, 304].includes($2) && $1.byteLength === 0) ? null : $1, { status: $2, headers: $3 })"
    jsNewResponseFromBytes :: JSVal -> Int -> JSVal -> IO JSVal

foreign import javascript unsafe "new Response($1.body, { status: $2, headers: $3 })"
    jsNewResponseFromPassthroughBody :: JSVal -> Int -> JSVal -> IO JSVal

foreign import javascript unsafe "new Response(null, {status: 101, webSocket: $1.webSocket, headers: $2})"
    jsUpgradeResponse :: JSVal -> JSVal -> IO JSVal

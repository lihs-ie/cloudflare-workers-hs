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
import Cloudflare.Workers.Internal.NativeResponse (NativeResponse (NativeResponse))
import Cloudflare.Workers.Internal.Streaming (readableStreamToJSVal)
import Control.Exception (throwIO)
import Data.ByteString.Lazy qualified as LazyByteString
import GHC.Wasm.Prim (JSVal)

responsetoJSVal :: Response -> IO JSVal
responsetoJSVal response =
    case responseBody response of
        ResponseBodyBytes byteString -> withHeaders $ \headersJSVal -> do
            bodyJSVal <- byteStringToJSByteArray byteString
            jsNewResponseFromBytes bodyJSVal responseStatusCode headersJSVal
        ResponseBodyLazyBytes lazyByteString -> withHeaders $ \headersJSVal -> do
            bodyJSVal <- byteStringToJSByteArray (LazyByteString.toStrict lazyByteString)
            jsNewResponseFromBytes bodyJSVal responseStatusCode headersJSVal
        ResponseBodyStream readableStream -> withHeaders $ \headersJSVal -> do
            jsNewResponseFromBytes (readableStreamToJSVal readableStream) responseStatusCode headersJSVal
        ResponseBodyNative (NativeResponse renderResponse) ->
            renderResponse responseStatusCode (responseHeaders response)
        ResponseBodyPassthrough (PassthroughResponse passthroughJSValue) ->
            pure passthroughJSValue
        body -> do
            headersJSValue <- headersToJSVal (responseHeaders response)
            responseBodyToJSVal (statusCode (responseStatus response)) headersJSValue body
  where
    responseStatusCode :: Int
    responseStatusCode = statusCode (responseStatus response)

    withHeaders :: (JSVal -> IO JSVal) -> IO JSVal
    withHeaders render = headersToJSVal (responseHeaders response) >>= render

responseBodyToJSVal :: Int -> JSVal -> ResponseBody -> IO JSVal
responseBodyToJSVal responseStatusCode headersJSValue responseBodyValue =
    case responseBodyValue of
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
        ResponseBodyPassthrough _ ->
            throwIO (userError "Passthrough response reached reconstructed response conversion")
        ResponseBodyNative _ ->
            throwIO (userError "Native response reached reconstructed response conversion")

foreign import javascript unsafe "new Response(([204, 205, 304].includes($2) && $1.byteLength === 0) ? null : $1, { status: $2, headers: $3 })"
    jsNewResponseFromBytes :: JSVal -> Int -> JSVal -> IO JSVal

foreign import javascript unsafe "new Response(null, {status: 101, webSocket: $1.webSocket, headers: $2})"
    jsUpgradeResponse :: JSVal -> JSVal -> IO JSVal

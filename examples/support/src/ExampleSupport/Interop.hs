{-# LANGUAGE MultilineStrings #-}

-- | JavaScript boundary helpers owned by the examples and their runtime fixtures.
--
-- These conversions deliberately do not belong to the public library API. An
-- application that exports raw JavaScript entrypoints owns the final conversion
-- between its domain values and 'JSVal'.
module ExampleSupport.Interop (
    byteStringToJSByteArray,
    jsByteArrayToByteString,
    jsValToText,
    textToJSVal,
    decodeEnveloped,
    readableStreamFromJSVal,
    responseToJSVal,
) where

import Cloudflare.Workers.Headers (headersToList)
import Cloudflare.Workers.HTTP (
    PassthroughResponse (PassthroughResponse),
    Response (responseBody, responseHeaders, responseStatus),
    ResponseBody (..),
    Status (statusCode),
 )
import Cloudflare.Workers.Streaming (ReadableStream)
import Control.Exception (throwIO)
import Data.ByteString (ByteString)
import Data.ByteString qualified as ByteString
import Data.ByteString.Unsafe (unsafeUseAsCStringLen)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import Data.Text.Encoding qualified as TextEncoding
import Data.Text.Encoding.Error qualified as TextEncodingError
import Data.Word (Word8)
import Foreign.Marshal.Alloc (allocaBytes)
import Foreign.Ptr (Ptr, castPtr)
import GHC.Wasm.Prim (JSVal)
import Unsafe.Coerce (unsafeCoerce)

byteStringToJSByteArray :: ByteString -> IO JSVal
byteStringToJSByteArray sourceByteString =
    unsafeUseAsCStringLen sourceByteString $ \(sourcePointer, byteCount) ->
        jsCopyBytesOutOfMemory (castPtr sourcePointer) byteCount

jsByteArrayToByteString :: JSVal -> IO ByteString
jsByteArrayToByteString sourceJSByteArray = do
    prepared <- jsPrepareByteArray sourceJSByteArray
    byteCount <- jsPreparedByteArrayLength prepared
    if byteCount < 0
        then throwIO (userError "the JavaScript value is not a byte-sized typed array")
        else
            allocaBytes byteCount $ \destinationPointer -> do
                jsCopyBytesIntoMemory prepared (castPtr destinationPointer) byteCount
                ByteString.packCStringLen (destinationPointer, byteCount)

jsValToText :: JSVal -> IO Text
jsValToText jsStringValue = do
    utf8BytesJSVal <- jsEncodeUtf8 jsStringValue
    utf8ByteString <- jsByteArrayToByteString utf8BytesJSVal
    pure (TextEncoding.decodeUtf8With TextEncodingError.lenientDecode utf8ByteString)

textToJSVal :: Text -> IO JSVal
textToJSVal sourceText =
    jsDecodeUtf8 =<< byteStringToJSByteArray (TextEncoding.encodeUtf8 sourceText)

decodeEnveloped :: (JSVal -> IO value) -> JSVal -> IO (Either Text value)
decodeEnveloped decodeValue envelopeJSVal = do
    tag <- jsEnvelopeTag envelopeJSVal
    case tag of
        1 -> Right <$> (decodeValue =<< jsEnvelopeValue envelopeJSVal)
        2 -> Left <$> (jsValToText =<< jsEnvelopeFailureMessage envelopeJSVal)
        _ -> pure (Left "the value crossing this boundary is not a { ok, value, message } envelope: its own `ok` field is not a boolean")

-- | Test-fixture adapter for feeding a native stream into the public consumer
-- functions. Production code obtains streams from public Request, R2, and
-- Socket APIs instead of constructing them from raw JavaScript values.
readableStreamFromJSVal :: JSVal -> ReadableStream
readableStreamFromJSVal = unsafeCoerce

-- | Marshal responses only at example-owned raw JavaScript fixture boundaries.
-- Public fetch entrypoints should normally use 'createFetchHandler' instead.
responseToJSVal :: Response -> IO JSVal
responseToJSVal response = do
    headersJSVal <- jsNewHeaders
    mapM_ (appendHeader headersJSVal) (headersToList (responseHeaders response))
    let responseStatusCode = statusCode (responseStatus response)
    case responseBody response of
        ResponseBodyBytes body ->
            byteStringToJSByteArray body >>= \bodyJSVal ->
                jsNewResponse bodyJSVal responseStatusCode headersJSVal
        ResponseBodyLazyBytes body ->
            byteStringToJSByteArray (LazyByteString.toStrict body) >>= \bodyJSVal ->
                jsNewResponse bodyJSVal responseStatusCode headersJSVal
        ResponseBodyPassthrough (PassthroughResponse rawResponse) ->
            pure rawResponse
        ResponseBodyWebSocket (PassthroughResponse rawResponse)
            | responseStatusCode == 101 -> jsNewWebSocketResponse rawResponse headersJSVal
            | otherwise -> throwIO (userError "WebSocket response status must remain 101")
        ResponseBodyStream _ ->
            throwIO (userError "raw stream marshalling is not part of the example fixture boundary")
  where
    appendHeader headersJSVal (name, value) = do
        nameJSVal <- textToJSVal name
        valueJSVal <- textToJSVal value
        jsAppendHeader headersJSVal nameJSVal valueJSVal

foreign import javascript unsafe "new Uint8Array(__exports.memory.buffer, $1, $2).slice()"
    jsCopyBytesOutOfMemory :: Ptr Word8 -> Int -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const source = $1;
      if (!ArrayBuffer.isView(source)) return { length: -1 };
      const prototype = Object.getPrototypeOf(Uint8Array.prototype);
      const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag).get.call(source);
      if (!['Uint8Array', 'Int8Array', 'Uint8ClampedArray'].includes(tag)) return { length: -1 };
      try {
        const byteCount = Object.getOwnPropertyDescriptor(prototype, 'length').get.call(source);
        const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer').get.call(source);
        const offset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset').get.call(source);
        if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > 2147483647) return { length: -1 };
        return { length: byteCount, bytes: new Uint8Array(buffer, offset, byteCount).slice() };
      } catch (_) {
        return { length: -1 };
      }
    })()
    """
    jsPrepareByteArray :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.length"
    jsPreparedByteArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "new Uint8Array(__exports.memory.buffer, $2, $3).set($1.bytes)"
    jsCopyBytesIntoMemory :: JSVal -> Ptr Word8 -> Int -> IO ()

foreign import javascript unsafe "new TextEncoder().encode($1)"
    jsEncodeUtf8 :: JSVal -> IO JSVal

foreign import javascript unsafe "new TextDecoder().decode($1)"
    jsDecodeUtf8 :: JSVal -> IO JSVal

foreign import javascript unsafe
    "($1 !== null && typeof $1 === 'object' && typeof $1.ok === 'boolean') ? ($1.ok ? 1 : 2) : 0"
    jsEnvelopeTag :: JSVal -> IO Int

foreign import javascript unsafe "$1.value"
    jsEnvelopeValue :: JSVal -> IO JSVal

foreign import javascript unsafe
    "typeof $1.message === 'string' && $1.message.length > 0 ? $1.message : 'the failure envelope carried no usable message'"
    jsEnvelopeFailureMessage :: JSVal -> IO JSVal

foreign import javascript unsafe "new Headers()"
    jsNewHeaders :: IO JSVal

foreign import javascript unsafe "$1.append($2, $3)"
    jsAppendHeader :: JSVal -> JSVal -> JSVal -> IO ()

foreign import javascript unsafe
    "new Response(([204, 205, 304].includes($2) && $1.byteLength === 0) ? null : $1, { status: $2, headers: $3 })"
    jsNewResponse :: JSVal -> Int -> JSVal -> IO JSVal

foreign import javascript unsafe "new Response(null, { status: 101, webSocket: $1.webSocket, headers: $2 })"
    jsNewWebSocketResponse :: JSVal -> JSVal -> IO JSVal

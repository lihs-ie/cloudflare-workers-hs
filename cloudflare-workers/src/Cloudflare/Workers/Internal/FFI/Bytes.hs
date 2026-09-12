module Cloudflare.Workers.Internal.FFI.Bytes (
    byteStringToJSByteArray,
    jsByteArrayToByteString,
    jsByteArrayToByteStringEither,
    JSByteArrayRejection (
        JSByteArrayLengthUnrepresentable,
        JSByteArrayNotAView,
        JSByteArrayUnknownRejection,
        JSByteArrayWrongElementWidth
    ),
    JSByteArrayReadError (JSByteArrayReadError),
    classifyJSByteArrayLengthCode,
    describeJSByteArrayRejection,
) where

import Control.Exception (Exception, throwIO)
import Data.ByteString (ByteString)
import Data.ByteString.Internal (create)
import Data.ByteString.Unsafe (unsafeUseAsCStringLen)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Word (Word8)
import Foreign.Ptr (Ptr, castPtr)
import GHC.Wasm.Prim (JSVal)

byteStringToJSByteArray :: ByteString -> IO JSVal
byteStringToJSByteArray sourceByteString =
    unsafeUseAsCStringLen sourceByteString $ \(sourcePointer, byteCount) ->
        jsCopyBytesOutOfMemory (castPtr sourcePointer) byteCount

data JSByteArrayRejection
    = JSByteArrayNotAView
    | JSByteArrayWrongElementWidth
    | JSByteArrayLengthUnrepresentable
    | JSByteArrayUnknownRejection Int
    deriving stock (Show, Eq)

newtype JSByteArrayReadError = JSByteArrayReadError Text
    deriving stock (Show, Eq)

instance Exception JSByteArrayReadError

classifyJSByteArrayLengthCode :: Int -> Either JSByteArrayRejection Int
classifyJSByteArrayLengthCode lengthCode
    | lengthCode >= 0 = Right lengthCode
    | lengthCode == -1 = Left JSByteArrayNotAView
    | lengthCode == -2 = Left JSByteArrayWrongElementWidth
    | lengthCode == -3 = Left JSByteArrayLengthUnrepresentable
    | otherwise = Left (JSByteArrayUnknownRejection lengthCode)

describeJSByteArrayRejection :: JSByteArrayRejection -> Text
describeJSByteArrayRejection JSByteArrayNotAView =
    "jsByteArrayToByteString: the JS value is not an ArrayBufferView \
    \(an ArrayBuffer, DataView, Blob, plain object, Array or string \
    \has no byte-array shape here -- wrap an ArrayBuffer with \
    \`new Uint8Array(buffer)` before crossing)"
describeJSByteArrayRejection JSByteArrayWrongElementWidth =
    "jsByteArrayToByteString: the JS value is an ArrayBufferView whose \
    \elements are wider than one byte, so its own .length counts \
    \elements rather than bytes"
describeJSByteArrayRejection JSByteArrayLengthUnrepresentable =
    "jsByteArrayToByteString: the JS value's .length must be a \
    \non-negative integer within the boundary limit, equal to its intrinsic \
    \view length, and backed by a readable, attached buffer"
describeJSByteArrayRejection (JSByteArrayUnknownRejection lengthCode) =
    "jsByteArrayToByteString: the JS side answered with the \
    \unrecognised rejection code "
        <> Text.pack (show lengthCode)

jsByteArrayToByteStringEither :: JSVal -> IO (Either Text ByteString)
jsByteArrayToByteStringEither sourceJSByteArray = do
    prepared <- jsPrepareByteArray sourceJSByteArray
    lengthCode <- jsPreparedByteArrayLength prepared
    case classifyJSByteArrayLengthCode lengthCode of
        Left rejection -> pure (Left (describeJSByteArrayRejection rejection))
        Right byteCount ->
            Right
                <$> create
                    byteCount
                    (\destinationPointer -> jsCopyBytesIntoMemory prepared destinationPointer byteCount)

jsByteArrayToByteString :: JSVal -> IO ByteString
jsByteArrayToByteString sourceJSByteArray = do
    outcome <- jsByteArrayToByteStringEither sourceJSByteArray
    either (throwIO . JSByteArrayReadError) pure outcome

foreign import javascript unsafe "new Uint8Array(__exports.memory.buffer, $1, $2).slice()"
    jsCopyBytesOutOfMemory :: Ptr Word8 -> Int -> IO JSVal

-- Validate intrinsic view shape as well as the visible length. Typed arrays can
-- shadow .length and BYTES_PER_ELEMENT with own properties; trusting those
-- fields could allocate more bytes than .set copies, exposing uninitialised
-- memory in the resulting ByteString.
foreign import javascript unsafe
    """
    (() => {
      const source = $1;
      if (!ArrayBuffer.isView(source)) {
        return { length: -1 };
      }
      const prototype = Object.getPrototypeOf(Uint8Array.prototype);
      const tag = Object.getOwnPropertyDescriptor(prototype, Symbol.toStringTag).get.call(source);
      if (!['Uint8Array', 'Int8Array', 'Uint8ClampedArray'].includes(tag)) {
        return { length: -2 };
      }
      try {
        const byteCount = source.length;
        const actualLength = Object.getOwnPropertyDescriptor(prototype, 'length').get.call(source);
        const buffer = Object.getOwnPropertyDescriptor(prototype, 'buffer').get.call(source);
        new Uint8Array(buffer, 0, 0);
        if (!Number.isSafeInteger(byteCount) || byteCount < 0 || byteCount > 2147483647
          || byteCount !== actualLength) {
          return { length: -3 };
        }
        const offset = Object.getOwnPropertyDescriptor(prototype, 'byteOffset').get.call(source);
        // Snapshot before Haskell allocation: create() may grow WASM memory
        // and detach a caller view of that same memory buffer.
        const bytes = new Uint8Array(buffer, offset, byteCount).slice();
        return { length: byteCount, bytes };
      } catch (_) {
        return { length: -3 };
      }
    })()
    """
    jsPrepareByteArray :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.length"
    jsPreparedByteArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "new Uint8Array(__exports.memory.buffer, $2, $3).set($1.bytes)"
    jsCopyBytesIntoMemory :: JSVal -> Ptr Word8 -> Int -> IO ()

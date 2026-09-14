module Cloudflare.Workers.Internal.ByteArray (
    JSByteArrayRejection (..),
    classifyJSByteArrayLengthCode,
    describeJSByteArrayRejection,
) where

import Data.Text (Text)
import Data.Text qualified as Text

data JSByteArrayRejection
    = JSByteArrayNotAView
    | JSByteArrayWrongElementWidth
    | JSByteArrayLengthUnrepresentable
    | JSByteArrayUnknownRejection Int
    deriving stock (Show, Eq)

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

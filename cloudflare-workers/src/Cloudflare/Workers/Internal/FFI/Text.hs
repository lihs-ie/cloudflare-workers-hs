module Cloudflare.Workers.Internal.FFI.Text (
    jsValToText,
    textToJSVal,
    JSStringReadOutcome (JSStringAbsent, JSStringNotAString, JSStringNull, JSStringPresent),
    JSStringValueKind (JSStringKindNull, JSStringKindOther, JSStringKindString, JSStringKindUndefined),
    classifyJSStringValueKind,
    describeJSStringReadOutcome,
    readJSStringValue,
) where

import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import Data.Text.Encoding.Error qualified as TextEncodingError
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString)

jsValToText :: JSVal -> IO Text
jsValToText jsStringValue = do
    utf8BytesJSVal <- jsEncodeUtf8 jsStringValue
    utf8ByteString <- jsByteArrayToByteString utf8BytesJSVal
    pure (TextEncoding.decodeUtf8With TextEncodingError.lenientDecode utf8ByteString)

data JSStringValueKind
    = JSStringKindUndefined
    | JSStringKindNull
    | JSStringKindString
    | JSStringKindOther
    deriving stock (Show, Eq)

classifyJSStringValueKind :: Int -> JSStringValueKind
classifyJSStringValueKind 0 = JSStringKindUndefined
classifyJSStringValueKind 1 = JSStringKindNull
classifyJSStringValueKind 2 = JSStringKindString
classifyJSStringValueKind _ = JSStringKindOther

data JSStringReadOutcome
    = JSStringAbsent
    | JSStringNull
    | JSStringNotAString Text
    | JSStringPresent Text
    deriving stock (Show, Eq)

describeJSStringReadOutcome :: JSStringReadOutcome -> Text
describeJSStringReadOutcome JSStringAbsent = "the field was absent (undefined)"
describeJSStringReadOutcome JSStringNull = "the field was null"
describeJSStringReadOutcome (JSStringNotAString typeOfName) =
    "the field was a " <> typeOfName <> ", not a string"
describeJSStringReadOutcome (JSStringPresent stringValue) =
    "the string " <> Text.pack (show stringValue)

readJSStringValue :: JSVal -> IO JSStringReadOutcome
readJSStringValue jsValue = do
    kindCode <- jsStringValueKindCode jsValue
    case classifyJSStringValueKind kindCode of
        JSStringKindUndefined -> pure JSStringAbsent
        JSStringKindNull -> pure JSStringNull
        JSStringKindString -> JSStringPresent <$> jsValToText jsValue
        JSStringKindOther -> JSStringNotAString <$> (jsValToText =<< jsTypeOfName jsValue)

textToJSVal :: Text -> IO JSVal
textToJSVal text = do
    utf8BytesJSVal <- byteStringToJSByteArray (TextEncoding.encodeUtf8 text)
    jsDecodeUtf8 utf8BytesJSVal

foreign import javascript unsafe "new TextEncoder().encode($1)"
    jsEncodeUtf8 :: JSVal -> IO JSVal

foreign import javascript unsafe "$1 === undefined ? 0 : ($1 === null ? 1 : (typeof $1 === 'string' ? 2 : 3))"
    jsStringValueKindCode :: JSVal -> IO Int

foreign import javascript unsafe "typeof $1"
    jsTypeOfName :: JSVal -> IO JSVal

foreign import javascript unsafe "new TextDecoder().decode($1)"
    jsDecodeUtf8 :: JSVal -> IO JSVal

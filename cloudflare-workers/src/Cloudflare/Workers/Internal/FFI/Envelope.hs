module Cloudflare.Workers.Internal.FFI.Envelope (
    decodeEnveloped,
    decodeEnvelopedWithError,
    EnvelopeTag (EnvelopeFailureTag, EnvelopeMalformedTag, EnvelopeSuccessTag),
    classifyEnvelopeTagCode,
    dispatchEnvelopeDecoding,
    readEnvelopeTag,
    describeMalformedEnvelope,
    envelopeFailureMessage,
) where

import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Text (
    JSStringReadOutcome (JSStringPresent),
    describeJSStringReadOutcome,
    readJSStringValue,
 )

data EnvelopeTag
    = EnvelopeSuccessTag
    | EnvelopeFailureTag
    | EnvelopeMalformedTag
    deriving stock (Show, Eq)

classifyEnvelopeTagCode :: Int -> EnvelopeTag
classifyEnvelopeTagCode 1 = EnvelopeSuccessTag
classifyEnvelopeTagCode 2 = EnvelopeFailureTag
classifyEnvelopeTagCode _ = EnvelopeMalformedTag

envelopeFailureMessage :: JSStringReadOutcome -> Text
envelopeFailureMessage (JSStringPresent messageText)
    | not (Text.null messageText) = messageText
envelopeFailureMessage messageOutcome =
    "the failure envelope carried no usable message ("
        <> describeJSStringReadOutcome messageOutcome
        <> ")"

decodeEnveloped :: (JSVal -> IO a) -> JSVal -> IO (Either Text a)
decodeEnveloped decodeValue envelopeJSVal = do
    envelopeTag <- readEnvelopeTag envelopeJSVal
    case envelopeTag of
        EnvelopeSuccessTag -> Right <$> (decodeValue =<< jsEnvelopeValueField envelopeJSVal)
        EnvelopeFailureTag ->
            Left . envelopeFailureMessage <$> (readJSStringValue =<< jsEnvelopeMessageField envelopeJSVal)
        EnvelopeMalformedTag -> Left <$> describeMalformedEnvelope envelopeJSVal

readEnvelopeTag :: JSVal -> IO EnvelopeTag
readEnvelopeTag envelopeJSVal =
    classifyEnvelopeTagCode <$> jsEnvelopeOkTagCode envelopeJSVal

describeMalformedEnvelope :: JSVal -> IO Text
describeMalformedEnvelope envelopeJSVal = do
    okOutcome <- readJSStringValue =<< jsEnvelopeOkField envelopeJSVal
    pure
        ( "the value crossing this boundary is not a { ok, value, message } \
          \envelope: its own `ok` field is not a boolean ("
            <> describeJSStringReadOutcome okOutcome
            <> ")"
        )

decodeEnvelopedWithError ::
    (JSVal -> IO success) ->
    (JSVal -> IO failure) ->
    (Text -> failure) ->
    JSVal ->
    IO (Either failure success)
decodeEnvelopedWithError decodeValue decodeFailure malformedFailure envelopeJSVal = do
    envelopeTag <- readEnvelopeTag envelopeJSVal
    dispatchEnvelopeDecoding
        envelopeTag
        (decodeValue =<< jsEnvelopeValueField envelopeJSVal)
        (decodeFailure =<< jsEnvelopeErrorField envelopeJSVal)
        (malformedFailure <$> describeMalformedEnvelope envelopeJSVal)

dispatchEnvelopeDecoding ::
    EnvelopeTag ->
    IO success ->
    IO failure ->
    IO failure ->
    IO (Either failure success)
dispatchEnvelopeDecoding EnvelopeSuccessTag decodeSuccess _ _ = Right <$> decodeSuccess
dispatchEnvelopeDecoding EnvelopeFailureTag _ decodeFailure _ = Left <$> decodeFailure
dispatchEnvelopeDecoding EnvelopeMalformedTag _ _ decodeMalformed = Left <$> decodeMalformed

foreign import javascript unsafe "($1 !== null && typeof $1 === 'object' && typeof $1.ok === 'boolean') ? ($1.ok ? 1 : 2) : 0"
    jsEnvelopeOkTagCode :: JSVal -> IO Int

foreign import javascript unsafe "($1 === null || $1 === undefined) ? undefined : $1.ok"
    jsEnvelopeOkField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.value"
    jsEnvelopeValueField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.message"
    jsEnvelopeMessageField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.error"
    jsEnvelopeErrorField :: JSVal -> IO JSVal

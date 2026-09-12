module Servant.Cloudflare.Workers.Access.Internal.FFI.SubtleCrypto (
    importKeyViaFFI,
    verifyViaFFI,
    jsDateNowMillis,
) where

import Cloudflare.Workers.Internal.FFI.Envelope (
    EnvelopeTag (EnvelopeFailureTag, EnvelopeMalformedTag, EnvelopeSuccessTag),
    describeMalformedEnvelope,
    readEnvelopeTag,
 )
import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

importKeyViaFFI :: JSVal -> IO (Either Text JSVal)
importKeyViaFFI jwkJSONTextJSVal = do
    envelopeJSVal <- jsImportKeyEnveloped jwkJSONTextJSVal
    decodeSubtleEnvelope jsSubtleEnvelopeKeyValueField envelopeJSVal

verifyViaFFI :: JSVal -> JSVal -> JSVal -> IO (Either Text Bool)
verifyViaFFI cryptoKeyJSVal signatureBytesJSVal dataBytesJSVal = do
    envelopeJSVal <- jsVerifyEnveloped cryptoKeyJSVal signatureBytesJSVal dataBytesJSVal
    decodeSubtleEnvelope jsSubtleEnvelopeVerifiedValueField envelopeJSVal

decodeSubtleEnvelope :: (JSVal -> IO a) -> JSVal -> IO (Either Text a)
decodeSubtleEnvelope readValueField envelopeJSVal = do
    envelopeTag <- readEnvelopeTag envelopeJSVal
    case envelopeTag of
        EnvelopeSuccessTag -> Right <$> readValueField envelopeJSVal
        EnvelopeFailureTag -> Left <$> (jsValToText =<< jsSubtleEnvelopeMessageField envelopeJSVal)
        EnvelopeMalformedTag -> Left <$> describeMalformedEnvelope envelopeJSVal

foreign import javascript safe
    """
    (async () => {
      try {
        const jwk = JSON.parse($1);
        const key = await crypto.subtle.importKey(
          'jwk',
          jwk,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );

        return {
          ok: true,
          value: key,
          message: null
        };
      } catch (error) {
        return {
          ok: false,
          value: null,
          message: String((error && error.message) || error)
        };
      }
    })()
    """
    jsImportKeyEnveloped :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        const verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', $1, $2, $3);

        return {
          ok: true,
          value: verified,
          message: null
        };
      } catch (error) {
        return {
          ok: false,
          value: false,
          message: String((error && error.message) || error)
        };
      }
    })()
    """
    jsVerifyEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.value"
    jsSubtleEnvelopeKeyValueField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.value === true"
    jsSubtleEnvelopeVerifiedValueField :: JSVal -> IO Bool

foreign import javascript unsafe "$1.message"
    jsSubtleEnvelopeMessageField :: JSVal -> IO JSVal

foreign import javascript unsafe "Date.now()"
    jsDateNowMillis :: IO Double

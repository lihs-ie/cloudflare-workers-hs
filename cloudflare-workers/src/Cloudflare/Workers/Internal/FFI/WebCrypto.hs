module Cloudflare.Workers.Internal.FFI.WebCrypto (
    importRS256JWKViaFFI,
    verifyRS256ViaFFI,
) where

import Cloudflare.Workers.Internal.FFI.Envelope (
    EnvelopeTag (EnvelopeFailureTag, EnvelopeMalformedTag, EnvelopeSuccessTag),
    describeMalformedEnvelope,
    readEnvelopeTag,
 )
import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

importRS256JWKViaFFI :: JSVal -> IO (Either Text JSVal)
importRS256JWKViaFFI jwkJSONTextJSVal = do
    envelopeJSVal <- jsImportRS256JWKEnveloped jwkJSONTextJSVal
    decodeWebCryptoEnvelope jsWebCryptoEnvelopeKeyValueField envelopeJSVal

verifyRS256ViaFFI :: JSVal -> JSVal -> JSVal -> IO (Either Text Bool)
verifyRS256ViaFFI cryptoKeyJSVal signatureBytesJSVal dataBytesJSVal = do
    envelopeJSVal <- jsVerifyRS256Enveloped cryptoKeyJSVal signatureBytesJSVal dataBytesJSVal
    decodeWebCryptoEnvelope jsWebCryptoEnvelopeVerifiedValueField envelopeJSVal

decodeWebCryptoEnvelope :: (JSVal -> IO a) -> JSVal -> IO (Either Text a)
decodeWebCryptoEnvelope readValueField envelopeJSVal = do
    envelopeTag <- readEnvelopeTag envelopeJSVal
    case envelopeTag of
        EnvelopeSuccessTag -> Right <$> readValueField envelopeJSVal
        EnvelopeFailureTag -> Left <$> (jsValToText =<< jsWebCryptoEnvelopeMessageField envelopeJSVal)
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
    jsImportRS256JWKEnveloped :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        const verified = await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          $1,
          $2,
          $3
        );

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
    jsVerifyRS256Enveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.value"
    jsWebCryptoEnvelopeKeyValueField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.value === true"
    jsWebCryptoEnvelopeVerifiedValueField :: JSVal -> IO Bool

foreign import javascript unsafe "$1.message"
    jsWebCryptoEnvelopeMessageField :: JSVal -> IO JSVal

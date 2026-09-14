module Cloudflare.Workers.WebCrypto (
    CryptoKey,
    WebCryptoError (..),
    importRS256JWK,
    verifyRS256,
) where

import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Cloudflare.Workers.Internal.FFI.WebCrypto (importRS256JWKViaFFI, verifyRS256ViaFFI)
import Control.Exception (Exception, throwIO)
import Data.Aeson (Value)
import Data.Aeson qualified as Aeson
import Data.ByteString (ByteString)
import Data.Text (Text)
import Data.Text.Lazy qualified as LazyText
import Data.Text.Lazy.Encoding qualified as LazyTextEncoding
import GHC.Wasm.Prim (JSVal)

-- | An opaque key imported by the Workers Web Crypto API.
newtype CryptoKey = CryptoKey JSVal

-- | A failure reported while importing a key or verifying a signature.
newtype WebCryptoError = WebCryptoError Text
    deriving stock (Show, Eq)

instance Exception WebCryptoError

-- | Import a JSON Web Key for RSASSA-PKCS1-v1_5 with SHA-256 verification.
--
-- The label is included in import failures so callers can identify the key
-- without exposing the runtime representation of 'CryptoKey'.
importRS256JWK :: Text -> Value -> IO CryptoKey
importRS256JWK label jwk = do
    jwkJSONTextJSVal <- textToJSVal (lazyUTF8ByteStringToText (Aeson.encode jwk))
    outcome <- importRS256JWKViaFFI jwkJSONTextJSVal
    case outcome of
        Right cryptoKeyJSVal -> pure (CryptoKey cryptoKeyJSVal)
        Left message -> throwIO (WebCryptoError ("importRS256JWK: label=" <> label <> ": " <> message))
  where
    lazyUTF8ByteStringToText = LazyText.toStrict . LazyTextEncoding.decodeUtf8

-- | Verify an RSASSA-PKCS1-v1_5 SHA-256 signature.
verifyRS256 :: CryptoKey -> ByteString -> ByteString -> IO Bool
verifyRS256 (CryptoKey cryptoKeyJSVal) signature message = do
    signatureJSVal <- byteStringToJSByteArray signature
    messageJSVal <- byteStringToJSByteArray message
    outcome <- verifyRS256ViaFFI cryptoKeyJSVal signatureJSVal messageJSVal
    case outcome of
        Right verified -> pure verified
        Left failure -> throwIO (WebCryptoError ("verifyRS256: " <> failure))

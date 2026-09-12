module Servant.Cloudflare.Workers.Access.SubtleCrypto (
    JWK (..),
    CryptoKey,
    SubtleCryptoError (..),
    subtleImportKey,
    subtleVerify,
) where

import Control.Exception (Exception, throwIO)
import Data.Aeson (FromJSON (parseJSON), Value, (.:))
import Data.Aeson qualified as Aeson
import Data.ByteString (ByteString)
import Data.Text (Text)
import Data.Text.Lazy qualified as LazyText
import Data.Text.Lazy.Encoding qualified as LazyTextEncoding
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Servant.Cloudflare.Workers.Access.Internal.FFI.SubtleCrypto (importKeyViaFFI, verifyViaFFI)

data JWK = JWK
    { jwkKid :: Text
    , jwkValue :: Value
    }
    deriving stock (Show, Eq)

instance FromJSON JWK where
    parseJSON jwkJsonValue =
        Aeson.withObject
            "JWK"
            (\jwkObject -> JWK <$> jwkObject .: "kid" <*> pure jwkJsonValue)
            jwkJsonValue

newtype CryptoKey = CryptoKey JSVal

newtype SubtleCryptoError = SubtleCryptoError Text
    deriving stock (Show, Eq)

instance Exception SubtleCryptoError

subtleImportKey :: Text -> JWK -> IO CryptoKey
subtleImportKey kidLabel jwk = do
    jwkJSONTextJSVal <- textToJSVal (lazyUTF8ByteStringToText (Aeson.encode (jwkValue jwk)))
    outcome <- importKeyViaFFI jwkJSONTextJSVal
    case outcome of
        Right cryptoKeyJSVal -> pure (CryptoKey cryptoKeyJSVal)
        Left message -> throwIO (SubtleCryptoError ("subtleImportKey: kid=" <> kidLabel <> ": " <> message))
  where
    lazyUTF8ByteStringToText = LazyText.toStrict . LazyTextEncoding.decodeUtf8

subtleVerify :: CryptoKey -> ByteString -> ByteString -> IO Bool
subtleVerify (CryptoKey cryptoKeyJSVal) signature message = do
    signatureJSVal <- byteStringToJSByteArray signature
    messageJSVal <- byteStringToJSByteArray message
    outcome <- verifyViaFFI cryptoKeyJSVal signatureJSVal messageJSVal
    case outcome of
        Right verified -> pure verified
        Left message' -> throwIO (SubtleCryptoError ("subtleVerify: " <> message'))

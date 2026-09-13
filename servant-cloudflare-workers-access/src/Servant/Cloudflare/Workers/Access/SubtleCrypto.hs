module Servant.Cloudflare.Workers.Access.SubtleCrypto (
    JWK (..),
    CryptoKey,
    SubtleCryptoError (..),
    subtleImportKey,
    subtleVerify,
) where

import Cloudflare.Workers.WebCrypto qualified as WebCrypto
import Control.Exception (Exception, catch, throwIO)
import Data.Aeson (FromJSON (parseJSON), Value, withObject, (.:))
import Data.ByteString (ByteString)
import Data.Text (Text)

data JWK = JWK
    { jwkKid :: Text
    , jwkValue :: Value
    }
    deriving stock (Show, Eq)

instance FromJSON JWK where
    parseJSON jwkJsonValue =
        withObject
            "JWK"
            (\jwkObject -> JWK <$> jwkObject .: "kid" <*> pure jwkJsonValue)
            jwkJsonValue

newtype CryptoKey = CryptoKey WebCrypto.CryptoKey

newtype SubtleCryptoError = SubtleCryptoError Text
    deriving stock (Show, Eq)

instance Exception SubtleCryptoError

subtleImportKey :: Text -> JWK -> IO CryptoKey
subtleImportKey kidLabel jwk =
    (CryptoKey <$> WebCrypto.importRS256JWK kidLabel (jwkValue jwk))
        `catch` mapImportError kidLabel

subtleVerify :: CryptoKey -> ByteString -> ByteString -> IO Bool
subtleVerify (CryptoKey cryptoKey) signature message =
    WebCrypto.verifyRS256 cryptoKey signature message
        `catch` mapVerifyError

mapImportError :: Text -> WebCrypto.WebCryptoError -> IO a
mapImportError kidLabel (WebCrypto.WebCryptoError message) =
    throwIO (SubtleCryptoError ("subtleImportKey: kid=" <> kidLabel <> ": " <> message))

mapVerifyError :: WebCrypto.WebCryptoError -> IO a
mapVerifyError (WebCrypto.WebCryptoError message) =
    throwIO (SubtleCryptoError ("subtleVerify: " <> message))

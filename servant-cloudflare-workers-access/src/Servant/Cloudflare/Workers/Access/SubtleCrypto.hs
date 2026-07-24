module Servant.Cloudflare.Workers.Access.SubtleCrypto (
    JWK,
    CryptoKey,
    subtleImportKey,
    subtleVerify,
) where

import Data.ByteString (ByteString)
import Data.Text (Text)

data JWK = JWKSTUB

data CryptoKey = CryptoKeySTUB

subtleImportKey :: Text -> JWK -> IO CryptoKey
subtleImportKey = error "umimplemented"

subtleVerify :: CryptoKey -> ByteString -> ByteString -> IO Bool
subtleVerify = error "unimplemented"

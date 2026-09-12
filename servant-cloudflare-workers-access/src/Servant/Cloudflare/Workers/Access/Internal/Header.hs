module Servant.Cloudflare.Workers.Access.Internal.Header (
    JWTHeaderClaims (..),
    decodeJWTHeader,
) where

import Control.Monad (unless)
import Data.Aeson (FromJSON, (.:))
import Data.Aeson qualified as Aeson
import Data.Text (Text)
import Data.Text qualified as Text
import Servant.Cloudflare.Workers.Access.Internal.Base64URL (decodeBase64URL)

data JWTHeaderClaims = JWTHeaderClaims
    { jwtHeaderClaimsAlg :: Text
    , jwtHeaderClaimsKid :: Text
    }
    deriving stock (Show, Eq)

instance FromJSON JWTHeaderClaims where
    parseJSON = Aeson.withObject "JWTHeaderClaims" $ \headerObject ->
        JWTHeaderClaims
            <$> headerObject .: "alg"
            <*> headerObject .: "kid"

decodeJWTHeader :: Text -> Either Text JWTHeaderClaims
decodeJWTHeader rawJWT = do
    headerSegmentText <- case Text.splitOn "." rawJWT of
        [headerPart, _, _] -> Right headerPart
        otherParts -> Left ("malformed JWT: expected exactly 3 dot-separated parts, got " <> Text.pack (show (length otherParts)))
    headerBytes <- decodeBase64URL headerSegmentText
    headerClaims <- either (Left . createMalformedHeaderJsonMessage) Right (Aeson.eitherDecodeStrict headerBytes)
    unless (jwtHeaderClaimsAlg headerClaims == "RS256") $
        Left ("unsupported alg: " <> jwtHeaderClaimsAlg headerClaims)
    Right headerClaims
  where
    createMalformedHeaderJsonMessage underlyingMessage = "malformed JWT header JSON: " <> Text.pack underlyingMessage

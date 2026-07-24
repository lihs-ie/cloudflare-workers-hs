module Servant.Cloudflare.Workers.Access (
    AccessJWT (..),
    AccessClaims (..),
    AccessConfig (..),
    AccessError (..),
    verifyAccessJWT,
) where

import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8)
import Servant.Cloudflare.Workers.Access.SubtleCrypto (JWK, subtleImportKey, subtleVerify)

{- | Data.Text | Wraps the raw Cf-Access-Jwt-Assertion header value before it has been
 parsed and verified. Kept distinct from a bare Text so a handler cannot
 accidentally treat an unverified header value as trusted AccessClaims.
-}
newtype AccessJWT = AccessJWT {unAccessJWT :: Text}
    deriving stock (Show, Eq)

{- | Parsed and verified JWT payload. Cloudflare Access issues "email" as
an unregistered claim (looked up by string key from the raw claim map,
not a registered JWT field), so this record hand-picks the 5 fields the
course backbone app needs instead of exposing the whole claim map.
-}
data AccessClaims = AccessClaims
    { accessClaimsEmail :: Text
    , accessClaimsSubject :: Text
    , accessClaimsAudience :: [Text]
    , accessClaimsIssuer :: Text
    , accessClaimsExpiresAt :: Integer
    }
    deriving stock (Show, Eq)

data AccessConfig = AccessConfig
    { accessConfigAudience :: Text
    , accessConfigTeamDomain :: Text
    , accessConfigJWKSURL :: Text
    }
    deriving stock (Show, Eq)

data AccessError
    = AccessErrorInvalidSignature
    | AccessErrorExpored
    | AccessErrorAudienceMismach
    | AccessErrorMalformed Text
    deriving stock (Show, Eq)

verifyAccessJWT :: AccessConfig -> Text -> IO (Either AccessError AccessClaims)
verifyAccessJWT config rawJWT =
    case jwtParts rawJWT of
        Nothing -> pure (Left (AccessErrorMalformed "expected header.payload.signature"))
        Just (headerPart, payloadPart, signaturePart) -> do
            jwk <- fetchMatchingJWK (accessConfigJWKSURL config) headerPart
            cryptoKey <- subtleImportKey "RS256" jwk
            signatureValid <-
                subtleVerify
                    cryptoKey
                    (encodeUtf8 (headerPart <> "." <> payloadPart))
                    (encodeUtf8 signaturePart)
            if signatureValid
                then decodeClaims config payloadPart
                else pure (Left AccessErrorInvalidSignature)

jwtParts :: Text -> Maybe (Text, Text, Text)
jwtParts raw = case Text.splitOn "." raw of
    [headerPart, payloadPart, signaturePart] -> Just (headerPart, payloadPart, signaturePart)
    _ -> Nothing

fetchMatchingJWK :: Text -> Text -> IO JWK
fetchMatchingJWK = error "unimplemented"

decodeClaims :: AccessConfig -> Text -> IO (Either AccessError AccessClaims)
decodeClaims = error "unimplemented"

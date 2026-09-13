module Servant.Cloudflare.Workers.Access (
    AccessJWT (..),
    AccessClaims (..),
    AccessServiceClaims (..),
    AccessConfig (..),
    AccessError (..),
    AccessVerifierOptions (..),
    defaultAccessVerifierOptions,
    verifyAccessJWT,
    verifyAccessJWTWithOptions,
    verifyAccessServiceJWT,
    verifyAccessServiceJWTWithOptions,
) where

import Cloudflare.Workers.Observability (tailLog)
import Control.Exception (Exception, SomeException, catch, fromException, throwIO, try)
import Data.Aeson qualified as Aeson
import Data.Maybe (fromMaybe)
import Data.Proxy (Proxy (Proxy))
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8)
import Servant.Client.Core (clientIn, parseBaseUrl)
import Servant.Cloudflare.Workers.Access.Internal.Base64URL (decodeBase64URL)
import Servant.Cloudflare.Workers.Access.Internal.Claims
import Servant.Cloudflare.Workers.Access.Internal.Clock (currentEpochSeconds)
import Servant.Cloudflare.Workers.Access.Internal.Header (JWTHeaderClaims (..), decodeJWTHeader)
import Servant.Cloudflare.Workers.Access.Internal.JWKS (JWKSAPI)
import Servant.Cloudflare.Workers.Access.Internal.JWKSCache (lookupOrFetchJWKWith)
import Servant.Cloudflare.Workers.Access.SubtleCrypto (SubtleCryptoError, subtleImportKey, subtleVerify)
import Servant.Cloudflare.Workers.Client.Fetch (FetchClient (..))

{- | Data.Text | Wraps the raw Cf-Access-Jwt-Assertion header value before it has been
 parsed and verified. Kept distinct from a bare Text so a handler cannot
 accidentally treat an unverified header value as trusted AccessClaims.
-}
newtype AccessJWT = AccessJWT {unAccessJWT :: Text}
    deriving stock (Show, Eq)

-- | Verified user identity. Service tokens are rejected by the user verifier.
data AccessClaims = AccessClaims
    { accessClaimsEmail :: Text
    , accessClaimsSubject :: Text
    , accessClaimsAudience :: [Text]
    , accessClaimsIssuer :: Text
    , accessClaimsExpiresAt :: Integer
    }
    deriving stock (Show, Eq)

{- | Verified service identity. The identifier is Cloudflare's common_name
(service token client identifier), never the empty service-token subject.
-}
data AccessServiceClaims = AccessServiceClaims
    { accessServiceClaimsIdentifier :: Text
    , accessServiceClaimsAudience :: [Text]
    , accessServiceClaimsIssuer :: Text
    , accessServiceClaimsExpiresAt :: Integer
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

{- | Verification policy. TeamDomain remains the short team name; an explicit
issuer overrides the Cloudflare domain derivation without normalization.
-}
data AccessVerifierOptions = AccessVerifierOptions
    { accessVerifierOptionsClockSkewSeconds :: Integer
    , accessVerifierOptionsJWKSCacheTtlSeconds :: Integer
    , accessVerifierOptionsExpectedIssuer :: Maybe Text
    }
    deriving stock (Show, Eq)

defaultAccessVerifierOptions :: AccessVerifierOptions
defaultAccessVerifierOptions = AccessVerifierOptions 0 3600 Nothing

instance Exception AccessError

verifyAccessJWT :: AccessConfig -> Text -> IO (Either AccessError AccessClaims)
verifyAccessJWT = verifyAccessJWTWithOptions defaultAccessVerifierOptions

verifyAccessJWTWithOptions :: AccessVerifierOptions -> AccessConfig -> Text -> IO (Either AccessError AccessClaims)
verifyAccessJWTWithOptions options config = verifyJWTWithIdentity options config $ \claims ->
    case rawClaimsIdentity claims of
        RawUserIdentity email ->
            pure
                AccessClaims
                    { accessClaimsEmail = email
                    , accessClaimsSubject = rawClaimsSubject claims
                    , accessClaimsAudience = rawClaimsAudience claims
                    , accessClaimsIssuer = rawClaimsIssuer claims
                    , accessClaimsExpiresAt = rawClaimsExpiresAt claims
                    }
        RawServiceIdentity _ -> throwIO (AccessErrorMalformed "expected user identity")

{- | Verify an Access application JWT issued to a service token.
User JWTs are rejected even when their signature and audience are valid.
-}
verifyAccessServiceJWT :: AccessConfig -> Text -> IO (Either AccessError AccessServiceClaims)
verifyAccessServiceJWT = verifyAccessServiceJWTWithOptions defaultAccessVerifierOptions

-- | Service-token verification with the same cryptographic and time policy as users.
verifyAccessServiceJWTWithOptions :: AccessVerifierOptions -> AccessConfig -> Text -> IO (Either AccessError AccessServiceClaims)
verifyAccessServiceJWTWithOptions options config = verifyJWTWithIdentity options config $ \claims ->
    case rawClaimsIdentity claims of
        RawServiceIdentity identifier ->
            pure
                AccessServiceClaims
                    { accessServiceClaimsIdentifier = identifier
                    , accessServiceClaimsAudience = rawClaimsAudience claims
                    , accessServiceClaimsIssuer = rawClaimsIssuer claims
                    , accessServiceClaimsExpiresAt = rawClaimsExpiresAt claims
                    }
        RawUserIdentity _ -> throwIO (AccessErrorMalformed "expected service identity")

verifyJWTWithIdentity :: AccessVerifierOptions -> AccessConfig -> (RawClaims -> IO identity) -> Text -> IO (Either AccessError identity)
verifyJWTWithIdentity options config identity rawJWT = do
    outcome <- try @SomeException pipeline
    case outcome of
        Right claims -> pure (Right claims)
        Left exception -> do
            -- Never log exception messages: JSON errors and transport errors may
            -- contain attacker-controlled token contents or other credentials.
            let failure = fromMaybe (AccessErrorMalformed "verification failed") (fromException exception)
                constructorName = case fromException exception :: Maybe AccessError of
                    Just accessError -> accessErrorConstructorName accessError
                    Nothing -> case fromException exception :: Maybe SubtleCryptoError of
                        Just _ -> "SubtleCryptoError"
                        Nothing -> "SomeException"
            tailLog constructorName `catch` (\(_ :: SomeException) -> pure ())
            pure (Left failure)
  where
    malformed :: Either Text a -> IO a
    malformed = either (throwIO . AccessErrorMalformed) pure

    pipeline = do
        (headerPart, payloadPart, signaturePart) <-
            maybe (throwIO (AccessErrorMalformed "expected header.payload.signature")) pure (jwtParts rawJWT)
        header <- malformed (decodeJWTHeader rawJWT)
        jwk <-
            lookupOrFetchJWKWith
                ( ( do
                        baseURL <- parseBaseUrl (Text.unpack (accessConfigJWKSURL config))
                        Right <$> runFetchClient (clientIn (Proxy @JWKSAPI) (Proxy @FetchClient)) baseURL
                  )
                    `catch` (\(_ :: SomeException) -> pure (Left "JWKS fetch failed"))
                )
                currentEpochSeconds
                (max 0 (accessVerifierOptionsJWKSCacheTtlSeconds options))
                (accessConfigJWKSURL config)
                (jwtHeaderClaimsKid header)
                >>= malformed
        cryptoKey <- subtleImportKey (jwtHeaderClaimsKid header) jwk
        signature <- malformed (decodeBase64URL signaturePart)
        valid <- subtleVerify cryptoKey signature (encodeUtf8 (headerPart <> "." <> payloadPart))
        if valid then pure () else throwIO AccessErrorInvalidSignature
        payload <- malformed (decodeBase64URL payloadPart)
        claims <- malformed (either (Left . Text.pack) Right (Aeson.eitherDecodeStrict payload))
        now <- currentEpochSeconds
        case validateTimeClaims now (max 0 (accessVerifierOptionsClockSkewSeconds options)) (rawClaimsExpiresAt claims) (rawClaimsNotBefore claims) of
            Left TimeClaimsExpired -> throwIO AccessErrorExpored
            Left TimeClaimsNotYetValid -> throwIO (AccessErrorMalformed "not yet valid")
            Left TimeClaimsInconsistentWindow -> throwIO (AccessErrorMalformed "inconsistent validity window")
            Right () -> pure ()
        let issuer = fromMaybe ("https://" <> accessConfigTeamDomain config <> ".cloudflareaccess.com") (accessVerifierOptionsExpectedIssuer options)
        case matchAudienceAndIssuer (accessConfigAudience config) issuer claims of
            Left AudienceMismatchError -> throwIO AccessErrorAudienceMismach
            Left IssuerMismatchError -> throwIO (AccessErrorMalformed "issuer mismatch")
            Right () -> pure ()
        identity claims

accessErrorConstructorName :: AccessError -> Text
accessErrorConstructorName AccessErrorInvalidSignature = "AccessErrorInvalidSignature"
accessErrorConstructorName AccessErrorExpored = "AccessErrorExpored"
accessErrorConstructorName AccessErrorAudienceMismach = "AccessErrorAudienceMismach"
accessErrorConstructorName (AccessErrorMalformed _) = "AccessErrorMalformed"

jwtParts :: Text -> Maybe (Text, Text, Text)
jwtParts raw = case Text.splitOn "." raw of
    [headerPart, payloadPart, signaturePart]
        | not (any Text.null [headerPart, payloadPart, signaturePart]) -> Just (headerPart, payloadPart, signaturePart)
    _ -> Nothing

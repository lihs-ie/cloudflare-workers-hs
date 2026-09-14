module Servant.Cloudflare.Workers.Access.Internal.Claims (
    RawClaims (..),
    RawIdentity (..),
    TimeClaimsError (..),
    validateTimeClaims,
    AudienceIssuerError (..),
    matchAudienceAndIssuer,
) where

import Data.Aeson (FromJSON, (.:), (.:?))
import Data.Aeson qualified as Aeson
import Data.Aeson.Types (Parser)
import Data.Foldable (Foldable (toList))
import Data.Text (Text)
import Data.Text qualified as Text

data RawIdentity = RawUserIdentity Text | RawServiceIdentity Text
    deriving stock (Show, Eq)

data RawClaims = RawClaims
    { rawClaimsIdentity :: RawIdentity
    , rawClaimsSubject :: Text
    , rawClaimsAudience :: [Text]
    , rawClaimsIssuer :: Text
    , rawClaimsExpiresAt :: Integer
    , rawClaimsNotBefore :: Maybe Integer
    }
    deriving stock (Show, Eq)

instance FromJSON RawClaims where
    parseJSON = Aeson.withObject "RawClaims" $ \claimsObject -> do
        email <- claimsObject .:? "email"
        commonName <- claimsObject .:? "common_name"
        subject <- claimsObject .: "sub"
        identity <- case (email, commonName) of
            (Just address, Nothing) | not (Text.null address) && not (Text.null subject) -> pure (RawUserIdentity address)
            (Nothing, Just name) | not (Text.null name) && Text.null subject -> pure (RawServiceIdentity name)
            _ -> fail "invalid or ambiguous Access identity"
        RawClaims identity subject
            <$> (parseAudience =<< claimsObject .: "aud")
            <*> claimsObject .: "iss"
            <*> claimsObject .: "exp"
            <*> claimsObject .:? "nbf"
      where
        parseAudience :: Aeson.Value -> Parser [Text]
        parseAudience (Aeson.String audienceText) = pure [audienceText]
        parseAudience (Aeson.Array audienceArray) = traverse Aeson.parseJSON (toList audienceArray)
        parseAudience other = fail ("aud: expected a JSON string or an array of strings, got" <> show other)

data TimeClaimsError
    = TimeClaimsExpired
    | TimeClaimsNotYetValid
    | TimeClaimsInconsistentWindow
    deriving stock (Show, Eq)

validateTimeClaims :: Integer -> Integer -> Integer -> Maybe Integer -> Either TimeClaimsError ()
validateTimeClaims now skewSeconds expiresAt maybeNotBefore
    | maybe False (> expiresAt) maybeNotBefore = Left TimeClaimsInconsistentWindow
    | now > expiresAt + skewSeconds = Left TimeClaimsExpired
    | maybe False (\notBefore -> now < notBefore - skewSeconds) maybeNotBefore = Left TimeClaimsNotYetValid
    | otherwise = Right ()

data AudienceIssuerError
    = AudienceMismatchError
    | IssuerMismatchError
    deriving stock (Show, Eq)

matchAudienceAndIssuer :: Text -> Text -> RawClaims -> Either AudienceIssuerError ()
matchAudienceAndIssuer expectedAudience expectedIssuer rawClaims
    | expectedAudience `notElem` rawClaimsAudience rawClaims = Left AudienceMismatchError
    | rawClaimsIssuer rawClaims /= expectedIssuer = Left IssuerMismatchError
    | otherwise = Right ()

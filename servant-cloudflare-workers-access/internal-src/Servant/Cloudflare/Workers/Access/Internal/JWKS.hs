module Servant.Cloudflare.Workers.Access.Internal.JWKS (
    JWKSDocument (..),
    JWKSLookupError (..),
    findJWKByKid,
    JWKSAPI,
) where

import Data.Aeson (FromJSON, (.:))
import Data.Aeson qualified as Aeson
import Data.Text (Text)
import Servant.API (Get, JSON)
import Servant.Cloudflare.Workers.Access.SubtleCrypto (JWK (jwkKid))

newtype JWKSDocument = JWKSDocument
    { jwksDocumentKeys :: [JWK]
    }
    deriving stock (Show, Eq)

instance FromJSON JWKSDocument where
    parseJSON = Aeson.withObject "JWKSDocument" $ \jwksObject ->
        JWKSDocument <$> jwksObject .: "keys"

data JWKSLookupError
    = JWKSKidNotFound
    | JWKSKidAmbiguous
    deriving stock (Show, Eq)

findJWKByKid :: Text -> JWKSDocument -> Either JWKSLookupError JWK
findJWKByKid targetKid document =
    case filter ((== targetKid) . jwkKid) (jwksDocumentKeys document) of
        [matched] -> Right matched
        [] -> Left JWKSKidNotFound
        _ -> Left JWKSKidAmbiguous

type JWKSAPI = Get '[JSON] JWKSDocument

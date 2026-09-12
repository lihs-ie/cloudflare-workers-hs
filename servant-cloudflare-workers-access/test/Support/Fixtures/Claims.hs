module Support.Fixtures.Claims (claims, key) where

import Data.Aeson (object, (.=))
import Data.Text (Text)
import Servant.Cloudflare.Workers.Access.Internal.Claims
import Servant.Cloudflare.Workers.Access.SubtleCrypto

claims :: RawClaims
claims = RawClaims (RawUserIdentity "me@example.com") "subject" ["aud"] "issuer" 200 Nothing
key :: Text -> JWK
key kid = JWK kid (object ["kid" .= kid])

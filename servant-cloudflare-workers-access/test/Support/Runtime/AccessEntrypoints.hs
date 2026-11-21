module Support.Runtime.AccessEntrypoints where

import Cloudflare.Workers.Streaming qualified as Streaming
import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import WorkersSupport.Interop (byteStringToJSByteArray, decodeEnveloped, jsByteArrayToByteString, jsValToText, textToJSVal)
import Cloudflare.Workers.Reactor (WorkersExecutionContext(..), passThroughOnException, waitUntil)
import Data.Text qualified as Text
import Control.Exception (throwIO, try, SomeException, displayException)
import Data.Aeson qualified as Aeson
import Data.Aeson.Types (parseEither, (.:), (.:?), (.!=))
import Data.ByteString (ByteString)
import Data.Text.Encoding qualified as TextEncoding
import Servant.Cloudflare.Workers.Access (AccessConfig (..), AccessClaims (..), AccessVerifierOptions(..), defaultAccessVerifierOptions, verifyAccessJWTWithOptions, verifyAccessServiceJWTWithOptions, AccessServiceClaims(..))
import Servant.Cloudflare.Workers.Access.SubtleCrypto (subtleImportKey, subtleVerify)
import Support.Runtime.AccessVerification qualified as AccessVerification
import Support.Runtime.AccessRoutes qualified as AccessRoutes
import GHC.Wasm.Prim (JSVal)
import Trace.Hpc.Reflect (examineTix)

cryptoVerify :: JSVal -> JSVal -> JSVal -> IO JSVal
cryptoVerify jwkValue signatureValue messageValue = do
  jwkJSON <- jsValToText jwkValue
  jwk <- either fail pure (Aeson.eitherDecodeStrict (TextEncoding.encodeUtf8 jwkJSON))
  key <- subtleImportKey "runtime-fixture" jwk
  signature <- jsByteArrayToByteString signatureValue
  message <- jsByteArrayToByteString messageValue
  result <- subtleVerify key signature message
  textToJSVal (if result then "valid" else "invalid")


jwtVerify :: JSVal -> IO JSVal
jwtVerify tokenValue = do
  token <- jsValToText tokenValue
  result <- verifyAccessJWTWithOptions
    defaultAccessVerifierOptions{accessVerifierOptionsJWKSCacheTtlSeconds = 0}
    (AccessConfig "runtime-audience" "runtime-team" "https://runtime-team.cloudflareaccess.com/cdn-cgi/access/certs")
    token
  textToJSVal (either (const "rejected") accessClaimsEmail result)


jwtVerifyConfigured :: JSVal -> IO JSVal
jwtVerifyConfigured inputValue = do
  input <- jsValToText inputValue
  value <- either fail pure (Aeson.eitherDecodeStrict (TextEncoding.encodeUtf8 input))
  (token, audience, team, url, skew, ttl, issuer) <- either fail pure $ parseEither
    (Aeson.withObject "Access verification fixture" $ \object ->
      (,,,,,,) <$> object .: "token" <*> object .: "audience" <*> object .: "team"
        <*> object .: "url" <*> object .: "skew" <*> object .: "ttl"
        <*> object .:? "issuer") value
  kind <- either fail pure $ parseEither (Aeson.withObject "Identity kind" (\o -> o .:? "identityKind" .!= ("user" :: Text.Text))) value
  if skew < 0 || ttl <= 0
    then textToJSVal "rejected"
    else case kind of
      "service" -> do
        result <- verifyAccessServiceJWTWithOptions (AccessVerifierOptions skew ttl issuer) (AccessConfig audience team url) token
        textToJSVal (either (const "rejected") accessServiceClaimsIdentifier result)
      "user" -> do
        result <- verifyAccessJWTWithOptions (AccessVerifierOptions skew ttl issuer) (AccessConfig audience team url) token
        textToJSVal (either (const "rejected") accessClaimsEmail result)
      _ -> textToJSVal "rejected"



accessVerificationProbe :: JSVal -> JSVal -> IO JSVal
accessVerificationProbe = AccessVerification.accessVerificationProbe



accessRoutesProbe :: JSVal -> JSVal -> IO JSVal
accessRoutesProbe = AccessRoutes.accessRoutesProbe

module Servant.Cloudflare.Workers.Access.Internal.HeaderSpec (spec) where

import Data.Aeson qualified as Aeson
import Data.ByteString.Base64.URL qualified as Base64
import Data.List (isInfixOf)
import Servant.Cloudflare.Workers.Access.Internal.JWKS (JWKSDocument (..), findJWKByKid)
import Support.Fixtures.Claims (key)
import Data.Either (isLeft)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import Servant.Cloudflare.Workers.Access.Internal.Header
import Test.Syd

spec :: Spec
spec = describe "JWT header" $ do
    it "parses RS256 and rejects other algorithms" $ do
        decodeJWTHeader (Text.decodeUtf8 (Base64.encodeUnpadded "{\"alg\":\"RS256\",\"kid\":\"key\"}") <> ".payload.signature") `shouldBe` Right (JWTHeaderClaims "RS256" "key")
        decodeJWTHeader (Text.decodeUtf8 (Base64.encodeUnpadded "{\"alg\":\"none\",\"kid\":\"key\"}") <> ".payload.signature") `shouldBe` Left "unsupported alg: none"
    it "rejects invalid segment counts, encoding and JSON" $ do
        map decodeJWTHeader ["a", "a.b.c.d", "!.b.c", "bm90LWpzb24.b.c", "e30.b.c"] `shouldSatisfy` all isLeft

    it "reports the exact segment count without exposing token contents" $ do
        decodeJWTHeader "private" `shouldBe` Left "malformed JWT: expected exactly 3 dot-separated parts, got 1"
        decodeJWTHeader "private.payload" `shouldBe` Left "malformed JWT: expected exactly 3 dot-separated parts, got 2"
        decodeJWTHeader "a.b.c.d" `shouldBe` Left "malformed JWT: expected exactly 3 dot-separated parts, got 4"
    it "distinguishes header JSON errors from base64 decoding errors" $ do
        let token json = Text.decodeUtf8 (Base64.encodeUnpadded json) <> ".payload.signature"
            malformed result = case result of
                Left message -> Text.isPrefixOf "malformed JWT header JSON: " message && Text.length message > 27
                Right _ -> False
        mapM_ (\json -> decodeJWTHeader (token json) `shouldSatisfy` malformed)
            ["not-json", "null", "[]", "true", "{}", "{\"alg\":3,\"kid\":\"key\"}", "{\"alg\":\"RS256\",\"kid\":null}"]

    it "selects the matching JWKS key through the decoded header identifier" $ do
        let token = Text.decodeUtf8 (Base64.encodeUnpadded "{\"alg\":\"RS256\",\"kid\":\"selected\"}") <> ".payload.signature"
        case decodeJWTHeader token of
            Left message -> expectationFailure (Text.unpack message)
            Right header -> do
                jwtHeaderClaimsAlg header `shouldBe` "RS256"
                findJWKByKid (jwtHeaderClaimsKid header) (JWKSDocument [key "other", key "selected"]) `shouldBe` Right (key "selected")
    it "decodes header batches without fabricating a missing header" $ do
        (Aeson.eitherDecode "[{\"alg\":\"RS256\",\"kid\":\"key\"}]" :: Either String [JWTHeaderClaims]) `shouldBe` Right [JWTHeaderClaims "RS256" "key"]
        (Aeson.eitherDecode "[]" :: Either String [JWTHeaderClaims]) `shouldBe` Right []
        (Aeson.eitherDecode "[{}]" :: Either String [JWTHeaderClaims]) `shouldSatisfy` isLeft
        (Aeson.omittedField :: Maybe JWTHeaderClaims) `shouldBe` Nothing
    it "detects key rotation and algorithm changes in header audit snapshots" $ do
        let header = JWTHeaderClaims "RS256" "synthetic-key"
            single = show header
        map (/= header) [header{jwtHeaderClaimsKid = "rotated"}, header{jwtHeaderClaimsAlg = "other"}] `shouldBe` [True, True]
        single `shouldSatisfy` isInfixOf "synthetic-key"
        show [header, header] `shouldBe` ("[" <> single <> "," <> single <> "]")

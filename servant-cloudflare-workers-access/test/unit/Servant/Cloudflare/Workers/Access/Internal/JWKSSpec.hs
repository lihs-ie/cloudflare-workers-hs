module Servant.Cloudflare.Workers.Access.Internal.JWKSSpec (spec) where

import Data.Aeson qualified as Aeson
import Data.List (isInfixOf)
import Servant.Cloudflare.Workers.Access.SubtleCrypto (JWK)
import Hedgehog (forAll, property, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Servant.Cloudflare.Workers.Access.Internal.JWKS
import Support.Fixtures.Claims
import Test.Syd
import Test.Syd.Hedgehog ()

spec :: Spec
spec = describe "JWKS selection" $ do
    it "names the expected JWK type for a non-object input" $
        case Aeson.eitherDecode "42" :: Either String JWK of
            Left message -> message `shouldSatisfy` isInfixOf "JWK"
            Right _ -> expectationFailure "accepted a non-object JWK"
    it "names the expected JWKS document type for a non-object input" $
        case Aeson.eitherDecode "[]" :: Either String JWKSDocument of
            Left message -> message `shouldSatisfy` isInfixOf "JWKSDocument"
            Right _ -> expectationFailure "accepted a non-object JWKS document"
    it "selects only the matching key amongst unrelated keys" $
        findJWKByKid "target" (JWKSDocument [key "other", key "target"]) `shouldBe` Right (key "target")
    it "rejects missing and duplicate matching identifiers" $ do
        findJWKByKid "target" (JWKSDocument []) `shouldBe` Left JWKSKidNotFound
        findJWKByKid "target" (JWKSDocument [key "other"]) `shouldBe` Left JWKSKidNotFound
        findJWKByKid "target" (JWKSDocument [key "target", key "target"]) `shouldBe` Left JWKSKidAmbiguous
    it "unrelated duplicate keys do not affect selection" $ property $ do
        count <- forAll $ Gen.int (Range.linear 0 100)
        findJWKByKid "target" (JWKSDocument (key "target" : replicate count (key "other"))) === Right (key "target")

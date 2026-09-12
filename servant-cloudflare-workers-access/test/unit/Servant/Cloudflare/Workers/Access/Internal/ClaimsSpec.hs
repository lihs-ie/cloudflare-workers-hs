module Servant.Cloudflare.Workers.Access.Internal.ClaimsSpec (spec) where

import Data.Aeson (eitherDecode, eitherDecodeStrict)
import Data.Aeson qualified as Aeson
import Data.Either (isLeft)
import Data.List (isInfixOf)
import Hedgehog (forAll, property, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Servant.Cloudflare.Workers.Access.Internal.Claims
import Support.Fixtures.Claims
import Test.Syd
import Test.Syd.Hedgehog ()

spec :: Spec
spec = describe "Claims validation" $ do
    it "checks expiration and not-before including skew boundaries" $ do
        validateTimeClaims 210 10 200 Nothing `shouldBe` Right ()
        validateTimeClaims 211 10 200 Nothing `shouldBe` Left TimeClaimsExpired
        validateTimeClaims 90 10 200 (Just 100) `shouldBe` Right ()
        validateTimeClaims 89 10 200 (Just 100) `shouldBe` Left TimeClaimsNotYetValid
        validateTimeClaims 100 10 200 (Just 201) `shouldBe` Left TimeClaimsInconsistentWindow
    it "expiration threshold holds at arbitrary timestamps" $ property $ do
        expiry <- forAll $ Gen.integral (Range.linear (-100000) 100000)
        skew <- forAll $ Gen.integral (Range.linear 0 1000)
        validateTimeClaims (expiry + skew) skew expiry Nothing === Right ()
        validateTimeClaims (expiry + skew + 1) skew expiry Nothing === Left TimeClaimsExpired
    it "requires both audience membership and exact issuer" $ do
        matchAudienceAndIssuer "aud" "issuer" claims `shouldBe` Right ()
        matchAudienceAndIssuer "other" "issuer" claims `shouldBe` Left AudienceMismatchError
        matchAudienceAndIssuer "aud" "other" claims `shouldBe` Left IssuerMismatchError
    it "accepts the string audience representation" $
        eitherDecode "{\"email\":\"me@example.com\",\"sub\":\"subject\",\"aud\":\"aud\",\"iss\":\"issuer\",\"exp\":200}" `shouldBe` Right claims
    it "accepts the array audience representation" $
        eitherDecode "{\"email\":\"me@example.com\",\"sub\":\"subject\",\"aud\":[\"aud\"],\"iss\":\"issuer\",\"exp\":200}" `shouldBe` Right claims

    it "decodes service identity without a fabricated email or subject" $
        eitherDecode "{\"common_name\":\"client.access\",\"sub\":\"\",\"aud\":\"aud\",\"iss\":\"issuer\",\"exp\":200}"
            `shouldBe` Right (RawClaims (RawServiceIdentity "client.access") "" ["aud"] "issuer" 200 Nothing)
    it "rejects missing, mixed, empty and wrong-typed identities" $
        mapM_ (\fields ->
            isLeft (eitherDecodeStrict ("{" <> fields <> ",\"aud\":\"aud\",\"iss\":\"issuer\",\"exp\":200}") :: Either String RawClaims) `shouldBe` True)
            [ "\"sub\":\"user\""
            , "\"email\":\"\",\"sub\":\"user\""
            , "\"email\":\"user@example.com\",\"sub\":\"\""
            , "\"common_name\":\"\",\"sub\":\"\""
            , "\"common_name\":3,\"sub\":\"\""
            , "\"common_name\":\"client.access\",\"sub\":\"user\""
            , "\"email\":\"user@example.com\",\"common_name\":\"client.access\",\"sub\":\"user\""
            ]

    it "reports invalid audience shapes and rejects mixed arrays" $ do
        let decodeAudience value = eitherDecodeStrict ("{\"email\":\"me@example.com\",\"sub\":\"subject\",\"aud\":" <> value <> ",\"iss\":\"issuer\",\"exp\":200}") :: Either String RawClaims
        mapM_ (\(value, rendered) -> case decodeAudience value of
            Left message -> do
                message `shouldSatisfy` isInfixOf "aud: expected a JSON string or an array of strings, got"
                message `shouldSatisfy` isInfixOf rendered
            Right _ -> expectationFailure "accepted an invalid audience shape")
            [("null", "Null"), ("false", "Bool False"), ("3", "Number 3"), ("{}", "Object") ]
        decodeAudience "[\"aud\",3]" `shouldSatisfy` isLeft
    it "reports both absent and conflicting identities" $ do
        let decodeIdentity fields = eitherDecodeStrict ("{" <> fields <> ",\"sub\":\"subject\",\"aud\":\"aud\",\"iss\":\"issuer\",\"exp\":200}") :: Either String RawClaims
            identityDiagnostic result = case result of
                Left message -> "invalid or ambiguous Access identity" `isInfixOf` message
                Right _ -> False
        mapM_ (\fields -> decodeIdentity fields `shouldSatisfy` identityDiagnostic)
            [ "\"email\":null,\"common_name\":null"
            , "\"email\":\"me@example.com\",\"common_name\":\"service\""
            , "\"email\":\"\""
            ]
    it "decodes a not-before claim and rejects non-object claims" $ do
        eitherDecode "{\"email\":\"me@example.com\",\"sub\":\"subject\",\"aud\":\"aud\",\"iss\":\"issuer\",\"exp\":200,\"nbf\":100}"
            `shouldBe` Right claims{rawClaimsNotBefore = Just 100}
        case eitherDecode "[]" :: Either String RawClaims of
            Left message -> do
                message `shouldSatisfy` isInfixOf "RawClaims"
                message `shouldSatisfy` isInfixOf "Array"
            Right _ -> expectationFailure "accepted non-object claims"

    it "uses decoded identity and time metadata in a downstream authorization decision" $ do
        let input = "{\"email\":\"me@example.com\",\"sub\":\"subject\",\"aud\":\"aud\",\"iss\":\"issuer\",\"exp\":200,\"nbf\":100}"
        case eitherDecode input of
            Left message -> expectationFailure message
            Right decoded -> do
                (rawClaimsIdentity decoded, rawClaimsSubject decoded) `shouldBe` (RawUserIdentity "me@example.com", "subject")
                validateTimeClaims 150 0 (rawClaimsExpiresAt decoded) (rawClaimsNotBefore decoded) `shouldBe` Right ()
                validateTimeClaims 201 0 (rawClaimsExpiresAt decoded) (rawClaimsNotBefore decoded) `shouldBe` Left TimeClaimsExpired
    it "decodes claim batches and requires a value rather than an implicit identity" $ do
        let input = "[{\"email\":\"me@example.com\",\"sub\":\"subject\",\"aud\":\"aud\",\"iss\":\"issuer\",\"exp\":200}]"
        (eitherDecode input :: Either String [RawClaims]) `shouldBe` Right [claims]
        (eitherDecode "[]" :: Either String [RawClaims]) `shouldBe` Right []
        (eitherDecode "[{}]" :: Either String [RawClaims]) `shouldSatisfy` isLeft
        (Aeson.omittedField :: Maybe RawClaims) `shouldBe` Nothing
    it "detects changes in claim snapshots and produces single and batch diagnostics" $ do
        claimDiagnostics "RawClaims" claims
            [ claims{rawClaimsIdentity = RawServiceIdentity "service"}
            , claims{rawClaimsSubject = "other"}, claims{rawClaimsAudience = []}
            , claims{rawClaimsIssuer = "other"}, claims{rawClaimsExpiresAt = 201}
            , claims{rawClaimsNotBefore = Just 100}
            ]
        claimDiagnostics "RawUserIdentity" (RawUserIdentity "synthetic@example.test")
            [RawUserIdentity "other@example.test", RawServiceIdentity "service"]
        claimDiagnostics "TimeClaimsExpired" TimeClaimsExpired [TimeClaimsNotYetValid, TimeClaimsInconsistentWindow]
        claimDiagnostics "AudienceMismatchError" AudienceMismatchError [IssuerMismatchError]

-- Diagnostic output and structural inequality are used by a synthetic audit
-- consumer; actual Access verification never logs raw incoming token contents.
claimDiagnostics :: (Show value, Eq value) => String -> value -> [value] -> Expectation
claimDiagnostics constructor original changes = do
    let single = show original
    single `shouldSatisfy` isInfixOf constructor
    show [original, original] `shouldBe` ("[" <> single <> "," <> single <> "]")
    map (/= original) changes `shouldBe` replicate (length changes) True

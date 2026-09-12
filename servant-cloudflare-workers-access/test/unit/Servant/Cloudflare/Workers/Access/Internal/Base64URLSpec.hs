module Servant.Cloudflare.Workers.Access.Internal.Base64URLSpec (spec) where

import Data.ByteString.Base64.URL qualified as Base64
import Data.Either (isLeft)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import Hedgehog (forAll, property, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Servant.Cloudflare.Workers.Access.Internal.Base64URL
import Test.Syd
import Test.Syd.Hedgehog ()

spec :: Spec
spec = describe "Base64URL" $ do
    it "round trips arbitrary binary input" $ property $ do
        bytes <- forAll $ Gen.bytes (Range.linear 0 1024)
        decodeBase64URL (Text.decodeUtf8 (Base64.encodeUnpadded bytes)) === Right bytes
    it "rejects invalid alphabet and impossible length" $ do
        decodeBase64URL "!" `shouldSatisfy` isLeft
        decodeBase64URL "a" `shouldSatisfy` isLeft

    it "retains a diagnostic for malformed alphabet, length and Unicode input" $ do
        let hasDiagnostic result = case result of
                Left message -> Text.isPrefixOf "malformed base64URL: " message && Text.length message > 20
                Right _ -> False
        mapM_ (\input -> decodeBase64URL input `shouldSatisfy` hasDiagnostic) ["!", "a", "日本語"]

module Cloudflare.Workers.Binding.SecretSpec (spec) where
import Cloudflare.Workers.Binding.Secret
import Data.Text qualified as Text
import Test.Syd

spec :: Spec
spec = do
  it "reveals only through the explicit accessor and redacts every Show input" $ do
    mapM_ (\value -> do
      revealSecret (Secret value) `shouldBe` value
      show (Secret value) `shouldBe` Text.unpack redactedSecretText) ["", "sensitive-token", "秘密\NULvalue"]
    redactedSecretText `shouldBe` "Secret <redacted>"
  it "compares secret values without using their identical redacted representation" $ do
    (Secret "one" == Secret "one") `shouldBe` True
    (Secret "one" == Secret "two") `shouldBe` False
  it "redacts nested and list diagnostics without hiding value inequality" $ do
    showsPrec 11 (Secret "private-token") ")" `shouldBe` "Secret <redacted>)"
    showList [Secret "private-one", Secret "private-two"] "!"
      `shouldBe` "[Secret <redacted>,Secret <redacted>]!"
    (Secret "same" /= Secret "same") `shouldBe` False
    (Secret "one" /= Secret "two") `shouldBe` True

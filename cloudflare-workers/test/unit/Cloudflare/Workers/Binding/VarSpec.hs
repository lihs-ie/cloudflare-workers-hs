module Cloudflare.Workers.Binding.VarSpec (spec) where
import Cloudflare.Workers.Binding.Var
import Test.Syd

spec :: Spec
spec = do
  it "preserves empty and Unicode configuration text" $
    mapM_ (\value -> unVar (Var value) `shouldBe` value) ["", "development", "東京\NULx"]
  it "compares and displays nonsecret configuration" $ do
    (Var "a" == Var "a") `shouldBe` True
    (Var "a" == Var "b") `shouldBe` False
    show (Var "development") `shouldBe` "Var \"development\""
  it "keeps configuration differences visible in list diagnostics" $ do
    (Var "development" /= Var "production") `shouldBe` True
    (Var "development" /= Var "development") `shouldBe` False
    showList [Var "development", Var "production"] "!"
      `shouldBe` "[Var \"development\",Var \"production\"]!"

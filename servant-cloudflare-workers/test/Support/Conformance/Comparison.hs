module Support.Conformance.Comparison (assertCompatible) where
import Test.Syd (context, shouldBe)
import Support.Conformance.Oracle
assertCompatible :: RequestCase -> Observation -> Observation -> IO ()
assertCompatible input expected actual =
  context (unlines ["Request: " <> show input, "Reference: " <> show expected, "Workers: " <> show actual]) $
    compatible expected actual `shouldBe` True

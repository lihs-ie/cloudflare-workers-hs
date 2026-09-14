module Cloudflare.Workers.Binding.R2Spec (spec) where
import Cloudflare.Workers.HostTestKit
import Control.Exception (try)
import Cloudflare.Workers.Internal.R2Range (r2RangeComponentToJSNumber)
import Cloudflare.Workers.Binding.R2
import Data.ByteString qualified as BS
import Data.Maybe (isJust)
import Hedgehog
import Support.Cloudflare.Workers.Generators
import Test.Syd
import Test.Syd.Hedgehog ()
spec :: Spec
spec = do
  it "accepts the bulk maximum and rejects its successor" $ do
    r2KeyBatchIsValid (R2KeyBatch "first" []) `shouldBe` True
    r2KeyBatchIsValid (R2KeyBatch "first" (replicate 999 "rest")) `shouldBe` True
    r2KeyBatchIsValid (R2KeyBatch "first" (replicate 1000 "rest")) `shouldBe` False
  it "counts the mandatory first key and validates generated batch sizes" $ property $ do
    restCount <- forAll r2RestCount
    let batch = R2KeyBatch "first" (replicate restCount "rest")
    r2KeyBatchCount batch === restCount + 1
    r2KeyBatchIsValid batch === (restCount < 1000)

  it "requires exactly 32 encryption key bytes" $ property $ do
    count <- forAll ssecByteCount
    isJust (mkR2SsecKey (BS.replicate count 0)) === (count == 32)
  it "checks encryption key boundary examples" $ do
    map (isJust . mkR2SsecKey . (`BS.replicate` 0)) [0,31,32,33] `shouldBe` [False,False,True,False]

  it "rejects oversized delete batches before the FFI boundary" $ do
    result <- try (r2DeleteMany (R2Bucket phantomJSVal) (R2KeyBatch "first" (replicate 1000 "rest")))
    result `shouldBe` Left (R2DeleteFailed "R2 delete accepts at most 1000 keys")

  it "retains exact range boundaries and rejects values that cannot cross JavaScript" $ do
    map (r2RangeComponentToJSNumber "offset") [0,1,9007199254740991]
      `shouldBe` [Right 0,Right 1,Right 9007199254740991]
    map (r2RangeComponentToJSNumber "length") [-1,9007199254740992]
      `shouldBe` [Left "length: -1 is negative; an R2 range component must be a non-negative byte count",
                  Left "length: 9007199254740992 exceeds the largest integer a JS number represents exactly (9007199254740991), so it cannot cross this boundary without being rounded"]

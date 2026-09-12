module Cloudflare.Workers.Binding.KVSpec (spec) where
import Cloudflare.Workers.HostTestKit
import Control.Exception (try)
import Data.Functor (void)
import Cloudflare.Workers.Binding.KV
import Hedgehog
import Support.Cloudflare.Workers.Generators
import Test.Syd
import Test.Syd.Hedgehog ()
spec :: Spec
spec = do
  it "accepts the bulk maximum and rejects its successor" $ do
    kvKeyBatchIsValid (KVKeyBatch "first" []) `shouldBe` True
    kvKeyBatchIsValid (KVKeyBatch "first" (replicate 99 "rest")) `shouldBe` True
    kvKeyBatchIsValid (KVKeyBatch "first" (replicate 100 "rest")) `shouldBe` False
  it "counts the mandatory first key and validates generated batch sizes" $ property $ do
    restCount <- forAll kvRestCount
    let batch = KVKeyBatch "first" (replicate restCount "rest")
    kvKeyBatchCount batch === restCount + 1
    kvKeyBatchIsValid batch === (restCount < 100)

  it "validates every generated TTL against the minimum" $ property $ do
    seconds <- forAll cacheTtl
    kvCacheTtlIsValid (KVReadOptions (Just seconds)) === (seconds >= 30)
  it "default read options omit the TTL" $ kvCacheTtlIsValid kvReadDefaultOptions `shouldBe` True

  it "accepts 30 seconds and rejects 29 seconds" $ do
    kvCacheTtlIsValid (KVReadOptions (Just 29)) `shouldBe` False
    kvCacheTtlIsValid (KVReadOptions (Just 30)) `shouldBe` True
  it "rejects invalid read TTL before evaluating the FFI namespace" $ do
    result <- try (void (kvGet (KV phantomJSVal) "key" KVReadText (KVReadOptions (Just 29))))
    result `shouldBe` Left (KVInvalidCacheTtl 29)
  it "rejects too many bulk keys before evaluating the FFI namespace" $ do
    result <- try (void (kvGetMany (KV phantomJSVal) (KVKeyBatch "first" (replicate 100 "rest")) KVBulkReadText kvReadDefaultOptions))
    result `shouldBe` Left (KVTooManyKeys 101)

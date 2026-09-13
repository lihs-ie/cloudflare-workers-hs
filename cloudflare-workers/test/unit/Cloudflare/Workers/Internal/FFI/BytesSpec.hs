module Cloudflare.Workers.Internal.FFI.BytesSpec (spec) where
import Cloudflare.Workers.Internal.ByteArray
import Data.Text qualified as Text
import Test.Syd
spec :: Spec
spec = do
  it "classifies empty, positive, and every defined rejection code" $ do
    map classifyJSByteArrayLengthCode [0,1,maxBound,-1,-2,-3,-4,minBound]
      `shouldBe` [Right 0,Right 1,Right maxBound,Left JSByteArrayNotAView,Left JSByteArrayWrongElementWidth,Left JSByteArrayLengthUnrepresentable,Left (JSByteArrayUnknownRejection (-4)),Left (JSByteArrayUnknownRejection minBound)]
  it "explains each rejection and retains unknown codes" $ do
    Text.isInfixOf "not an ArrayBufferView" (describeJSByteArrayRejection JSByteArrayNotAView) `shouldBe` True
    Text.isInfixOf "wider than one byte" (describeJSByteArrayRejection JSByteArrayWrongElementWidth) `shouldBe` True
    Text.isInfixOf "non-negative integer" (describeJSByteArrayRejection JSByteArrayLengthUnrepresentable) `shouldBe` True
    Text.isSuffixOf "-42" (describeJSByteArrayRejection (JSByteArrayUnknownRejection (-42))) `shouldBe` True

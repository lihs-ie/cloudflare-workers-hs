module Cloudflare.Workers.HostTestKitSpec (spec) where
import Control.Exception (evaluate, try, ErrorCall, displayException)
import Data.List (isInfixOf)
import Support.HostPlugin
import Cloudflare.Workers.HostTestKit (phantomJSVal)
import Test.Syd
spec :: Spec
spec = describe "host phantom contract" $ do
  it "is a defined opaque value" $ evaluate (phantomJSVal `seq` ()) >>= (`shouldBe` ())

  it "preserves ordinary declarations while erasing JavaScript exports" $
    ordinaryValue >>= (`shouldBe` 42)
  it "fails explicitly when a JavaScript import is forced on the host" $ do
    outcome <- try foreignValue
    case (outcome :: Either ErrorCall Int) of
      Left exception -> do
        isInfixOf "foreignValue" (displayException exception) `shouldBe` True
        isInfixOf "host-GHC type-checking stub" (displayException exception) `shouldBe` True
      Right _ -> expectationFailure "host foreign import unexpectedly executed"

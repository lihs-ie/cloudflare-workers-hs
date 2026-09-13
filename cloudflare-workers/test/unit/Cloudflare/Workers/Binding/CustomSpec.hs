module Cloudflare.Workers.Binding.CustomSpec (spec) where

import Cloudflare.Workers.Binding.Custom (CustomBinding, withCustomBinding)
import Cloudflare.Workers.HostTestKit (phantomJSVal)
import Test.Syd (Spec, it, shouldReturn)
import Unsafe.Coerce (unsafeCoerce)

data TestCapability

spec :: Spec
spec = do
    it "passes the opaque binding only to the infrastructure callback" $ do
        -- Runtime construction is covered by the WASM BindingEnv fixture.
        let binding = unsafeCoerce phantomJSVal :: CustomBinding TestCapability
        withCustomBinding binding (\value -> pure (value `seq` ()))
            `shouldReturn` ()

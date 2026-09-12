module Storage.DurableObjectSpec (spec) where

import Hedgehog (evalIO, forAll, (===))
import Hedgehog qualified as H
import Support.Storage.Model (Operation (..), expected, operations)
import Support.Storage.ContractSpec qualified as Contract
import Support.Storage.Runtime (runOperations)
import Test.Syd
import Test.Syd.Hedgehog ()

spec :: Spec
spec = do
    Contract.spec
    describe "real WASM Durable Object storage model" $ do
        it "preserves replacement, deletion and transaction semantics" $ do
            let commands = [Get "a", Put "a" [0, 255], Get "a", Transaction "a" [42], Get "a", Delete "a", Delete "a", Get "a"]
            runOperations commands `shouldReturn` expected commands
        -- Each generated sequence starts a fresh native runtime; coverage adds
        -- process startup overhead. Keep all 100 trials with a bounded budget.
        withTimeout (180 * 1000000) $ it "matches a pure model for generated operation sequences" $ H.property $ do
            commands <- forAll operations
            actual <- evalIO $ runOperations commands
            actual === expected commands

{-# LANGUAGE OverloadedStrings #-}
module Quickstart.Background.CoordinatorSpec (spec) where
import Quickstart.Background.Coordinator
import Test.Syd

spec :: Spec
spec = describe "export coordinator lease fencing" $ do
    it "rejects a third concurrent generation" $ do
        let leases = [Lease "a" "one" 100, Lease "b" "two" 100]
        transition 1 (Acquire "c" "three") leases `shouldBe` (409, Nothing, leases)
    it "rejects duplicate active export acquisition" $ do
        let leases = [Lease "a" "one" 100]
        transition 1 (Acquire "a" "two") leases `shouldBe` (409, Nothing, leases)
    it "reclaims a lease at the exact expiration boundary" $ do
        let lease = Lease "a" "new" (100 + leaseDurationMillis)
        transition 100 (Acquire "a" "new") [Lease "a" "old" 100] `shouldBe` (200, Just lease, [lease])
    it "a stale token cannot release a replacement lease" $ do
        let leases = [Lease "a" "new" 100]
        transition 1 (Release "a" "old") leases `shouldBe` (409, Nothing, leases)
    it "a stale token cannot renew a replacement lease" $ do
        let leases = [Lease "a" "new" 100]
        transition 1 (Renew "a" "old") leases `shouldBe` (409, Nothing, leases)
    it "renewal retains token and extends its lifetime" $ do
        let lease = Lease "a" "current" (10 + leaseDurationMillis)
        transition 10 (Renew "a" "current") [Lease "a" "current" 100] `shouldBe` (200, Just lease, [lease])
    it "a valid release preserves another running generation" $ do
        let other = Lease "b" "two" 100
        transition 1 (Release "a" "one") [Lease "a" "one" 100, other] `shouldBe` (204, Nothing, [other])
    it "an expired token cannot be renewed" $
        transition 100 (Renew "a" "one") [Lease "a" "one" 100] `shouldBe` (409, Nothing, [])

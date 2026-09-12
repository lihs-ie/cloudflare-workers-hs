module Servant.Cloudflare.Workers.Access.Internal.ClockSpec (spec) where

import Data.Time.Clock.POSIX (getPOSIXTime)
import Servant.Cloudflare.Workers.Access.Internal.Clock (currentEpochSeconds)
import Test.Syd

spec :: Spec
spec = describe "Access epoch clock" $
    it "returns whole POSIX seconds bounded by the surrounding clock reads" $ do
        before <- floor <$> getPOSIXTime
        actual <- currentEpochSeconds
        after <- floor <$> getPOSIXTime
        -- Do not demand equality across a second boundary or assume a fixed date.
        actual `shouldSatisfy` (>= before)
        actual `shouldSatisfy` (<= after)

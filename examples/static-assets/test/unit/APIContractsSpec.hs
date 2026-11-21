{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}
module APIContractsSpec (spec) where
import Servant.API.Generic (fromServant, toServant)
import Servant.Links (AsLink, Link, allFieldLinks, fieldLink, linkURI)
import Test.Syd
import StaticAssets.API qualified as StaticAssets

spec :: Spec
spec = describe "static-assets public API" $ do
    it "preserves the static asset API prefix through generic route conversion" $ do
        let routes = roundTrip (allFieldLinks @StaticAssets.Routes)
        render (StaticAssets.health routes) `shouldBe` "api/health"

  where
    render = show . linkURI
    roundTrip :: StaticAssets.Routes (AsLink Link) -> StaticAssets.Routes (AsLink Link)
    roundTrip = fromServant . toServant

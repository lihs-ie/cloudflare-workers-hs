{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}
module APIContractsSpec (spec) where
import Servant.API.Generic (fromServant, toServant)
import Servant.Links (AsLink, Link, allFieldLinks, fieldLink, linkURI)
import Test.Syd
import Realtime.API qualified as Realtime

spec :: Spec
spec = describe "realtime public API" $ do
    it "projects realtime record links for a management navigation consumer" $ do
        let rooms :: Realtime.RoomRoutes (AsLink Link)
            rooms = fromServant (toServant (allFieldLinks @Realtime.RoomRoutes))
        render (Realtime.connect rooms) `shouldBe` "connect"
        render (Realtime.monitor rooms) `shouldBe` "monitor"
        render (Realtime.history rooms) `shouldBe` "history"
        render (Realtime.autoResponse rooms) `shouldBe` "auto-response"
        render (Realtime.allConnections rooms) `shouldBe` "all-connections"
        render (Realtime.connections rooms) `shouldBe` "connections"
        let routes :: Realtime.Routes (AsLink Link)
            routes = fromServant (toServant (allFieldLinks @Realtime.Routes))
        render (Realtime.health routes) `shouldBe` "health"
        render (Realtime.createRoom routes) `shouldBe` "rooms"
        render (Realtime.room routes "team one") `shouldBe` "rooms/team%20one"
        render (Realtime.roomByIdentifier routes "room-one") `shouldBe` "room-identifiers/room-one"

    it "keeps realtime management endpoints separate from room history" $ do
        render (fieldLink Realtime.health) `shouldBe` "health"
        render (fieldLink Realtime.createRoom) `shouldBe` "rooms"
        render (fieldLink Realtime.history) `shouldBe` "history"
        render (fieldLink Realtime.autoResponse) `shouldBe` "auto-response"
        render (fieldLink Realtime.allConnections) `shouldBe` "all-connections"
        render (fieldLink Realtime.connections) `shouldBe` "connections"

  where
    render = show . linkURI

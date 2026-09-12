{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}

-- | Public URL contracts derived from the actual example NamedRoutes APIs.
-- These tests detect endpoint renames, missing prefixes and capture escaping
-- changes without duplicating the API definitions in test-only types.
module Support.APIContracts (spec) where

import Data.Aeson
import GHC.Generics (Generic)
import GHC.Generics qualified as Generic
import Data.List (nub)
import Minimal.API qualified as Minimal
import Realtime.API qualified as Realtime
import Servant.API.Generic (fromServant, toServant)
import Servant.Links (AsLink, Link, allFieldLinks, fieldLink, linkURI)
import StaticAssets.API qualified as StaticAssets
import Test.Syd
import WorkflowExample.API qualified as Workflow

spec :: Spec
spec = describe "Example NamedRoutes public contracts" $ do
    it "keeps the minimal health URL and its documented JSON response" $ do
        let routes :: Minimal.Routes (AsLink Link)
            routes = fromServant (toServant (allFieldLinks @Minimal.Routes))
        render (Minimal.health routes) `shouldBe` "health"
        (toJSON (Minimal.Health "ok") :: Value)
            `shouldBe` object ["status" .= ("ok" :: String)]

    it "encodes minimal health singles and lists for JSON consumers" $ do
        let healthy = Minimal.Health "ok"
            degraded = Minimal.Health "degraded"
            expected = [object ["status" .= ("ok" :: String)], object ["status" .= ("degraded" :: String)]]
        Minimal.status healthy `shouldBe` "ok"
        Minimal.status degraded `shouldBe` "degraded"
        eitherDecode (encode healthy) `shouldBe` Right (head expected)
        eitherDecode (encode [healthy, degraded]) `shouldBe` Right expected
        toJSON [healthy, degraded] `shouldBe` toJSON expected

    it "supports a health diagnostic consumer and preserves required envelope payloads" $ do
        let healthy = Minimal.Health "ok"
            degraded = Minimal.Health "degraded"
        (Generic.to (Generic.from healthy) :: Minimal.Health) `shouldBe` healthy
        healthy /= degraded `shouldBe` True
        nub [healthy, healthy, degraded] `shouldBe` [healthy, degraded]
        show healthy `shouldBe` "Health {status = \"ok\"}"
        showList [healthy, degraded] "suffix" `shouldBe` "[" <> show healthy <> "," <> show degraded <> "]suffix"
        showsPrec 11 healthy "suffix" `shouldBe` "(" <> show healthy <> ")suffix"
        toJSON (Envelope healthy) `shouldBe` object ["payload" .= object ["status" .= ("ok" :: String)]]
        eitherDecode (encode (Envelope healthy)) `shouldBe` Right (toJSON (Envelope healthy))

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

    it "preserves the static asset API prefix through generic route conversion" $ do
        let routes = roundTrip (allFieldLinks @StaticAssets.Routes)
        render (StaticAssets.health routes) `shouldBe` "api/health"

    it "keeps realtime management endpoints separate from room history" $ do
        render (fieldLink Realtime.health) `shouldBe` "health"
        render (fieldLink Realtime.createRoom) `shouldBe` "rooms"
        render (fieldLink Realtime.history) `shouldBe` "history"
        render (fieldLink Realtime.autoResponse) `shouldBe` "auto-response"
        render (fieldLink Realtime.allConnections) `shouldBe` "all-connections"
        render (fieldLink Realtime.connections) `shouldBe` "connections"

    it "keeps workflow creation and generated-identifier creation distinct" $ do
        let routes = workflowLinks
        render (Workflow.health routes) `shouldBe` "health"
        render (Workflow.create routes) `shouldBe` "workflows"
        render (Workflow.createGenerated routes) `shouldBe` "workflows/generated"

    it "preserves the same escaped workflow identifier across lifecycle links" $ do
        let routes = workflowLinks
            identifier = "approval/team one"
        render (Workflow.status routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one"
        render (Workflow.approve routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one/approve"
        render (Workflow.control routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one/control"
        render (Workflow.audit routes identifier)
            `shouldBe` "workflows/approval%2Fteam%20one/audit"
  where
    render = show . linkURI
    roundTrip :: StaticAssets.Routes (AsLink Link) -> StaticAssets.Routes (AsLink Link)
    roundTrip = fromServant . toServant
    workflowLinks :: Workflow.Routes (AsLink Link)
    workflowLinks = fromServant (toServant (allFieldLinks @Workflow.Routes))

newtype Envelope a = Envelope {payload :: a} deriving (Generic)
instance ToJSON a => ToJSON (Envelope a) where
    toJSON = genericToJSON defaultOptions {omitNothingFields = True}
    toEncoding = genericToEncoding defaultOptions {omitNothingFields = True}

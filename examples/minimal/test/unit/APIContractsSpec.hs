{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}
module APIContractsSpec (spec) where
import Data.Aeson
import GHC.Generics (Generic)
import GHC.Generics qualified as Generic
import Data.List (nub)
import Servant.API.Generic (fromServant, toServant)
import Servant.Links (AsLink, Link, allFieldLinks, fieldLink, linkURI)
import Test.Syd
import Minimal.API qualified as Minimal

spec :: Spec
spec = describe "minimal public API" $ do
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

  where
    render = show . linkURI

newtype Envelope a = Envelope {payload :: a} deriving (Generic)
instance ToJSON a => ToJSON (Envelope a) where
    toJSON = genericToJSON defaultOptions {omitNothingFields = True}
    toEncoding = genericToEncoding defaultOptions {omitNothingFields = True}

module Quickstart.ManagementSpec (spec) where

import Data.Text qualified as T
import Data.Time
import Quickstart.Database (timeText)
import Quickstart.Management
import Servant.Cloudflare.Workers.Error
import Support.Management
import Test.Syd
import URLShortener.Domain

spec :: Spec
spec = do
  let Routes {createURL = create, listURLs = list, updateURL = edit, deleteURL = remove, getStats = stats} = server
      expectBad action = do
        outcome <- runWithoutStorage action
        case outcome of
          Left err -> serverErrorStatusCode err `shouldBe` 400
          Right _ -> expectationFailure "Expected rejection before storage access"
      validCreate = CreateURL "https://example.com/" Nothing
  describe "input boundary" $ do
    it "requires an idempotency key" $ expectBad (create Nothing validCreate)
    it "rejects empty idempotency keys" $ expectBad (create (Just "") validCreate)
    it "bounds idempotency key length" $ expectBad (create (Just (T.replicate 257 "x")) validCreate)
    it "bounds URL list page size" $ expectBad (list Nothing (Just 101))
    it "rejects zero page size" $ expectBad (list Nothing (Just 0))
    it "requires delete version" $ expectBad (remove "code" Nothing)
    it "rejects nonpositive delete version" $ expectBad (remove "code" (Just 0))
    it "rejects invalid edit before storage" $ expectBad (edit "code" (EditURL "javascript:alert(1)" Nothing 1))
    it "rejects expired edits before storage" $ expectBad (edit "code" (EditURL "https://example.com/" (Just clock) 1))
    it "requires stats start" $ expectBad (stats Nothing (Just (fromGregorian 2026 9 7)) Nothing Nothing)
    it "requires stats end" $ expectBad (stats (Just (fromGregorian 2026 9 7)) Nothing Nothing Nothing)
    it "rejects more than 366 inclusive days" $ expectBad (stats (Just (fromGregorian 2024 1 1)) (Just (fromGregorian 2025 1 1)) Nothing Nothing)
    it "rejects reversed stats dates" $ expectBad (stats (Just (fromGregorian 2026 9 7)) (Just (fromGregorian 2026 9 6)) Nothing Nothing)
  describe "database timestamp ordering" $ do
    it "orders exact seconds before fractional seconds" $ do
      (timeText clock < timeText (addUTCTime 0.1 clock)) `shouldBe` True
    it "round-trips subsecond expiry without rounding" $ do
      let value = addUTCTime 0.123456789012 clock
      (parseTimeM True defaultTimeLocale "%Y-%m-%dT%H:%M:%S%QZ" (T.unpack (timeText value)) :: Maybe UTCTime) `shouldBe` Just value

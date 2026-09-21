module Conformance.OracleSpec (spec) where
import Support.Conformance.Oracle
import Data.Aeson (eitherDecode)
import qualified Data.ByteString.Lazy as LBS
import Data.List (nub)
import Support.Conformance.Generators (requestCaseGen)
import Hedgehog (forAll, evalIO, property, tripping, (===))
import Paths_conformance_oracle (getDataFileName)
import Test.Syd
import Test.Syd.Hedgehog ()
import Text.Read (readMaybe)
spec :: Spec
spec = do
  describe "Replay diagnostics" $ do
    it "replays individual requests while retaining the unread command suffix" $ do
      let request = RequestCase "replay" "POST" "/echo" [("X-Trace", "one")] "body"
          changed = request {requestTarget = "/plain"}
      reads (show request <> " next") `shouldBe` [(request, " next")]
      (request /= changed) `shouldBe` True
      readMaybe (show [request, changed]) `shouldBe` Just [request, changed]
      readList (show [request, changed] <> " next") `shouldBe` [([request, changed], " next")]
    it "replays observed response batches and distinguishes changed payloads" $ do
      let observation = Observation 200 (Just "text/plain") "original"
          changed = observation {responseBody = "changed"}
      readMaybe (show observation) `shouldBe` Just observation
      reads (show observation <> " next") `shouldBe` [(observation, " next")]
      (observation /= changed) `shouldBe` True
      readMaybe (show [observation, changed]) `shouldBe` Just [observation, changed]
      readList (show [observation, changed] <> " next") `shouldBe` [([observation, changed], " next")]
  describe "Reference interpreter" $ do
    it "contains exactly 54 unique named cases" $ do
      length fixedCases `shouldBe` 54
      let names = map caseName fixedCases
      length (nub names) `shouldBe` 54
    it "regenerates the checked-in golden without drift" $ do
      fixture <- getDataFileName "test/Support/Golden/reference.json"
      bytes <- LBS.readFile fixture
      actual <- goldenDocument
      eitherDecode bytes `shouldBe` Right actual
    it "evaluates generated requests deterministically" $ property $ do
      request <- forAll requestCaseGen
      -- A failure report can be copied verbatim into a replay input without
      -- losing any method, target, duplicate header or body bytes.
      tripping request show readMaybe
      first <- evalIO (evaluateReference request)
      second <- evalIO (evaluateReference request)
      first === second
    mapM_ (\c -> it (show (caseName c)) $ do
      first <- evaluateReference c
      second <- evaluateReference c
      first `shouldBe` second) fixedCases
  describe "Compatibility boundary" $ do
    it "compares successful bodies exactly" $
      compatible (Observation 200 (Just "application/json") "a") (Observation 200 (Just "application/json") "b") `shouldBe` False
    it "compares successful identical bodies" $
      compatible (Observation 299 Nothing "a") (Observation 299 Nothing "a") `shouldBe` True
    it "does not compare informational or redirect bodies" $ do
      compatible (Observation 199 Nothing "a") (Observation 199 Nothing "b") `shouldBe` True
      compatible (Observation 300 Nothing "a") (Observation 300 Nothing "b") `shouldBe` True
    it "does not compare error bodies" $
      compatible (Observation 400 Nothing "a") (Observation 400 Nothing "b") `shouldBe` True
    it "permits the documented error Content-Type and body divergence" $ do
      compatible (Observation 400 Nothing "servant error") (Observation 400 (Just "application/json;charset=utf-8") "workers error") `shouldBe` True
      compatible (Observation 500 Nothing "servant error") (Observation 500 (Just "text/plain;charset=utf-8") "workers error") `shouldBe` True
    it "does not hide status changes across response classes" $ do
      compatible (Observation 400 Nothing "") (Observation 200 Nothing "") `shouldBe` False
      compatible (Observation 200 Nothing "") (Observation 400 Nothing "") `shouldBe` False
    it "still compares redirect Content-Type" $
      compatible (Observation 302 Nothing "") (Observation 302 (Just "text/plain") "") `shouldBe` False
    it "compares status and charset exactly" $ do
      compatible (Observation 400 Nothing "") (Observation 404 Nothing "") `shouldBe` False
      compatible (Observation 200 (Just "text/plain;charset=utf-8") "") (Observation 200 (Just "text/plain") "") `shouldBe` False

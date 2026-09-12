{-# LANGUAGE OverloadedStrings #-}
module RoutingSpec (spec) where
import Test.Syd
import Control.Exception (ErrorCall, IOException, SomeException, displayException, evaluate, try)
import Data.List (isInfixOf)
import Cloudflare.Workers.HTTP qualified as HTTP
import Cloudflare.Workers.Headers qualified as Headers
import Support.HTTP.Fixtures qualified as Fixtures
import Test.Syd.Hedgehog ()
import Hedgehog (property, forAll, evalIO, annotateShow, assert)
import Data.Text qualified as Text
import Support.Conformance.Oracle
import Support.Conformance.Generators (requestCaseGen)
import Support.Conformance.Comparison (assertCompatible)
import Support.Conformance.Worker (evaluateWorker)
spec :: Spec
spec = do
  describe "fixed reference cases" $ mapM_ (\input -> it (Text.unpack (caseName input)) $ do
    expected <- evaluateReference input
    actual <- evaluateWorker input
    assertCompatible input expected actual) fixedCases
  it "matches real servant-server for generated requests" $ property $ do
    input <- forAll requestCaseGen
    expected <- evalIO (evaluateReference input)
    actual <- evalIO (evaluateWorker input)
    annotateShow expected
    annotateShow actual
    assert (compatible expected actual)

  it "rejects an empty conformance target before evaluating the API" $ do
    result <- try @IOException (evaluateWorker (RequestCase "invalid" "GET" "" [] ""))
    case result of
      Left err -> ("invalid conformance URL" `isInfixOf` displayException err) `shouldBe` True
      Right _ -> expectationFailure "empty target must not select a route"
  it "includes request and both observations in mismatch diagnostics" $ do
    let input = RequestCase "mismatch" "GET" "/" [] ""
        expected = Observation 200 Nothing "expected-body"
        actual = Observation 500 Nothing "actual-body"
    result <- try @SomeException (assertCompatible input expected actual)
    case result of
      Left err -> mapM_ (\fragment -> (fragment `isInfixOf` displayException err) `shouldBe` True)
        ["Request:", "Reference:", "Workers:", "expected-body", "actual-body"]
      Right _ -> expectationFailure "mismatch must produce a diagnostic"
  it "inspects strict buffered adapter output and rejects native streams" $ do
    let response body = HTTP.createResponse (HTTP.Status 200) (Headers.headersFromList []) body
    Fixtures.bodyBytes (response (HTTP.ResponseBodyBytes "strict")) `shouldBe` "strict"
    result <- try @ErrorCall (evaluate (Fixtures.bodyBytes (response (HTTP.ResponseBodyStream (error "stream must remain opaque")))))
    case result of
      Left err -> ("expected buffered response" `isInfixOf` displayException err) `shouldBe` True
      Right _ -> expectationFailure "conformance comparison cannot inspect native streams"

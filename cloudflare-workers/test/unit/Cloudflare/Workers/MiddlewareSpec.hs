module Cloudflare.Workers.MiddlewareSpec (spec) where
import Cloudflare.Workers.Middleware
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Cloudflare.Workers.Observability
import Cloudflare.Workers.Reactor
import Cloudflare.Workers.HostTestKit
import Support.Cloudflare.Workers.HTTP
import Control.Exception (try, throwIO, IOException)
import Data.IORef
import Data.Maybe (isJust, isNothing)

import Data.Text qualified as Text
import Hedgehog
import Support.Cloudflare.Workers.Generators
import Test.Syd
import Test.Syd.Hedgehog ()
spec :: Spec
spec = do
  it "formats zero words with fixed version and variant bits" $
    formatRequestIdentifierUUIDv4 0 0 `shouldBe` "00000000-0000-4000-8000-000000000000"
  it "preserves payload bits while forcing version and variant" $
    formatRequestIdentifierUUIDv4 maxBound maxBound `shouldBe` "ffffffff-ffff-4fff-bfff-ffffffffffff"
  it "always generates canonical UUIDv4 layout" $ property $ do
    high <- forAll uuidWord
    low <- forAll uuidWord
    let value = formatRequestIdentifierUUIDv4 high low
    map Text.length (Text.splitOn "-" value) === [8,4,4,4,12]
    Text.index value 14 === '4'
    assert (Text.index value 19 `elem` ['8','9','a','b'])

  it "uses cf-ray as the request identifier and replaces an existing value" $ do
    let request = requestWithHeaders (headersFromList [("CF-Ray","ray-123"),(requestIdHeaderName,"old")])
    result <- withRequestId (\updated environment context -> do
      environment `shouldBe` (7 :: Int)
      context `seq` pure (createResponse (Status 200) (requestHeaders updated) (ResponseBodyBytes ""))) request 7 (WorkersExecutionContext phantomJSVal)
    headerLookupAll requestIdHeaderName (responseHeaders result) `shouldBe` ["ray-123"]
    responseStatus result `shouldBe` Status 200
    case responseBody result of
      ResponseBodyBytes bytes -> bytes `shouldBe` ""
      _ -> expectationFailure "request identifier middleware changed response body"
  it "generates a request identifier when cf-ray is absent" $ do
    let request = requestWithHeaders (headersFromList [])
    result <- withRequestId (\updated _ _ -> pure (createResponse (Status 200) (requestHeaders updated) (ResponseBodyBytes ""))) request () (WorkersExecutionContext phantomJSVal)
    fmap Text.length (headerLookup requestIdHeaderName (responseHeaders result)) `shouldBe` Just 36
    responseStatus result `shouldBe` Status 200
    case responseBody result of
      ResponseBodyBytes bytes -> bytes `shouldBe` ""
      _ -> expectationFailure "generated identifier middleware changed response body"
  it "logs request start and successful completion without changing the response" $ do
    records <- newIORef []
    let request = requestWithHeaders (headersFromList [(requestIdHeaderName,"request"),("cf-ray","ray")])
        response = createResponse (Status 201) (headersFromList [("x-handler","retained")]) (ResponseBodyBytes "ok")
    result <- withStructuredLoggingUsing (\record -> modifyIORef' records (++ [record])) (\received environment context -> do
      requestMethod received `shouldBe` GET
      isNothing (requestBody received) `shouldBe` True
      isNothing (requestBodyReader received) `shouldBe` True
      requestDataCenter received `shouldBe` Nothing
      environment `shouldBe` (9 :: Int)
      context `seq` pure response) request 9 (WorkersExecutionContext phantomJSVal)
    responseStatus result `shouldBe` Status 201
    headerLookup "x-handler" (responseHeaders result) `shouldBe` Just "retained"
    case responseBody result of
      ResponseBodyBytes bytes -> bytes `shouldBe` "ok"
      _ -> expectationFailure "logging middleware changed the response body"
    entries <- readIORef records
    map logRecordMessage entries `shouldBe` ["request started","request completed"]
    map logRecordRequestId entries `shouldBe` ["request","request"]
    map logRecordRayId entries `shouldBe` [Just "ray",Just "ray"]
    map logRecordMethod entries `shouldBe` [Just "GET",Just "GET"]
    map logRecordPath entries `shouldBe` [Just "/sample",Just "/sample"]
    map logRecordStatus entries `shouldBe` [Nothing,Just 201]
    map (isJust . logRecordDurationMs) entries `shouldBe` [False,True]
    map (fmap (>= 0) . logRecordDurationMs) entries `shouldBe` [Nothing,Just True]
    map logRecordErrorKind entries `shouldBe` [Nothing,Nothing]
  it "logs handler failures and rethrows the original exception" $ do
    records <- newIORef []
    let failureException = userError "handler failure"
    outcome <- try (withStructuredLoggingUsing (\record -> modifyIORef' records (++ [record])) (\_ _ _ -> throwIO failureException) (requestWithHeaders (headersFromList [])) () (WorkersExecutionContext phantomJSVal))
    case (outcome :: Either IOException Response) of
      Left actual -> actual `shouldBe` failureException
      Right _ -> expectationFailure "handler exception was swallowed"
    entries <- readIORef records
    map logRecordLevel entries `shouldBe` [LogInfo,LogError]
    map logRecordRequestId entries `shouldBe` ["unknown","unknown"]
    map logRecordErrorKind entries `shouldBe` [Nothing,Just "SomeException"]
    map logRecordRayId entries `shouldBe` [Nothing,Nothing]
    map logRecordMethod entries `shouldBe` [Just "GET",Just "GET"]
    map logRecordPath entries `shouldBe` [Just "/sample",Just "/sample"]
    map logRecordStatus entries `shouldBe` [Nothing,Nothing]
    map (fmap (>= 0) . logRecordDurationMs) entries `shouldBe` [Nothing,Just True]
    map (Text.isInfixOf "handler failure" . logRecordMessage) entries `shouldBe` [False,True]
  it "connects configured logging to the handler without changing environment" $ do
    let request = requestWithHeaders (headersFromList [])
    response <- withStructuredLogging (LoggerConfig LogInfo 0) (\received environment context -> do
      requestPath received `shouldBe` "/sample"
      headerLookup "cf-ray" (requestHeaders received) `shouldBe` Nothing
      context `seq` pure (createResponse (Status environment) (headersFromList []) (ResponseBodyBytes ""))) request 204 (WorkersExecutionContext phantomJSVal)
    responseStatus response `shouldBe` Status 204
    headerLookup "cf-ray" (responseHeaders response) `shouldBe` Nothing
    case responseBody response of
      ResponseBodyBytes bytes -> bytes `shouldBe` ""
      _ -> expectationFailure "configured logging changed response body"

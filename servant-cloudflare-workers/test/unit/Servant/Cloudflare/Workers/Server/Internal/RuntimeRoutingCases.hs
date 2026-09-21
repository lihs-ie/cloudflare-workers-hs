{-# LANGUAGE OverloadedStrings #-}
module Servant.Cloudflare.Workers.Server.Internal.RuntimeRoutingCases (spec) where

import Control.Exception (ErrorCall, IOException, displayException, evaluate, try)
import Data.List (isInfixOf)
import Data.Aeson qualified as Aeson
import Data.Text (Text)
import Cloudflare.Workers.Headers (headerLookup, headersFromList)
import Cloudflare.Workers.HTTP
import Support.HTTP.Fixtures (bodyBytes, context)
import Support.Runtime.Routing (routingFixture)
import Support.Server.Requests (atPath)
import Test.Syd hiding (context)

spec :: Spec
spec = describe "host/WASM routing matrix" $ do
  it "checks the extended interpreter matrix" $ do
    response <- routingFixture "matrix" (atPath "/") context
    responseStatus response `shouldBe` Status 200
    case Aeson.eitherDecode (bodyBytes response) :: Either String [Text] of
      Left failure -> expectationFailure failure
      Right names -> length names `shouldBe` 27
  mapM_ (\(mode, method, path, status, body, contentType, allow) ->
    it (show (mode, method, path)) $ do
      response <- routingFixture mode (atPath path){requestMethodField = method} context
      responseStatus response `shouldBe` Status status
      bodyBytes response `shouldBe` body
      headerLookup "Content-Type" (responseHeaders response) `shouldBe` contentType
      headerLookup "Allow" (responseHeaders response) `shouldBe` allow)
    [ ("no-content-get", GET, "/", 204, "", Nothing, Nothing)
    , ("no-content-get", HEAD, "/", 204, "", Nothing, Nothing)
    , ("no-content-delete", DELETE, "/", 204, "", Nothing, Nothing)
    , ("head", HEAD, "/", 200, "", Just "text/plain;charset=utf-8", Nothing)
    , ("head", GET, "/", 200, "payload", Just "text/plain;charset=utf-8", Nothing)
    , ("method-choice", POST, "/", 200, "post", Just "text/plain;charset=utf-8", Nothing)
    , ("capture-all", GET, "/", 200, "[]", Just "application/json;charset=utf-8", Nothing)
    , ("capture-all", GET, "/1/2", 200, "[1,2]", Just "application/json;charset=utf-8", Nothing)
    , ("empty-prefix", GET, "/", 200, "42", Just "application/json;charset=utf-8", Nothing)
    , ("named-context", GET, "/", 200, "42", Just "application/json;charset=utf-8", Nothing)
    ]
  mapM_ (\(mode, method, path, status, allow) ->
    it (show (mode, method, path, status)) $ do
      response <- routingFixture mode (atPath path){requestMethodField = method} context
      responseStatus response `shouldBe` Status status
      headerLookup "Allow" (responseHeaders response) `shouldBe` allow)
    [ ("no-content-get", POST, "/", 405, Just "GET, HEAD")
    , ("no-content-delete", HEAD, "/", 405, Just "DELETE")
    , ("no-content-failure", DELETE, "/", 400, Nothing)
    , ("method-choice", DELETE, "/", 405, Just "GET, HEAD, POST")
    , ("capture-all", GET, "/1/nope", 400, Nothing)
    , ("empty", GET, "/", 404, Nothing)
    , ("head", GET, "/extra", 404, Nothing)
    ]
  it "NoContent ignores incompatible Accept because it has no representation" $ do
    response <- routingFixture "no-content-get"
      (atPath "/"){requestHeaders = headersFromList [("Accept", "image/png")]} context
    responseStatus response `shouldBe` Status 204
    headerLookup "Content-Type" (responseHeaders response) `shouldBe` Nothing
  it "HEAD keeps application response headers" $ do
    response <- routingFixture "head" (atPath "/"){requestMethodField = HEAD} context
    headerLookup "X-Result" (responseHeaders response) `shouldBe` Just "present"

  it "extracts strict response bytes without changing their contents" $
    bodyBytes (createResponse (Status 200) (headersFromList []) (ResponseBodyBytes "strict body"))
      `shouldBe` "strict body"
  it "rejects fixture response bodies that cannot be inspected as bytes" $ do
    result <- try @ErrorCall (evaluate (bodyBytes (createResponse (Status 204) (headersFromList []) (ResponseBodyStream (error "stream must remain opaque")))))
    case result of
      Left failure -> ("expected buffered response" `isInfixOf` displayException failure) `shouldBe` True
      Right _ -> expectationFailure "a streaming body must not be silently interpreted as buffered bytes"
  it "rejects an empty fixture path with a useful diagnostic" $ do
    result <- try @ErrorCall (evaluate (atPath ""))
    case result of
      Left failure -> ("invalid test path" `isInfixOf` displayException failure) `shouldBe` True
      Right _ -> expectationFailure "an empty fixture URL must be rejected"
  it "rejects unknown routing scenario names" $ do
    result <- try @IOException (routingFixture "not-a-scenario" (atPath "/") context)
    case result of
      Left failure -> ("Unknown routing fixture mode" `isInfixOf` displayException failure) `shouldBe` True
      Right _ -> expectationFailure "unknown fixture mode must not select an arbitrary route"

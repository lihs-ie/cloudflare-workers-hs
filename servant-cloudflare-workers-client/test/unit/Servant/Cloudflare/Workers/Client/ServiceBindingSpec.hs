module Servant.Cloudflare.Workers.Client.ServiceBindingSpec (spec) where

import Cloudflare.Workers.Headers (headersFromList, headersToList)
import Cloudflare.Workers.HTTP qualified as Workers
import Cloudflare.Workers.URL (urlText)
import Control.Monad.Trans.Except (runExceptT)
import Data.Sequence qualified as Seq
import Data.ByteString.Lazy qualified as LBS
import Network.HTTP.Types (statusCode)
import Servant.Client.Core (RequestBody (..), ResponseF (..))
import Servant.Cloudflare.Workers.Client.Internal.FFI.Fetch (buildServiceRequest, workersResponseToStreamingResponse)
import Servant.Types.SourceT qualified as SourceT
import Test.Syd

spec :: Spec
spec = describe "Service Binding transport conversion" $ do
    it "preserves method, URL, duplicate headers and binary request bytes" $ do
        outcome <- buildServiceRequest "https://internal.example/items?value=a%2Fb" "PATCH"
            (headersFromList [("X-Test", "first"), ("X-Test", "second")])
            (Just (RequestBodyBS "\NUL\255payload"))
        case outcome of
            Left failure -> expectationFailure (show failure)
            Right request -> do
                Workers.requestMethod request `shouldBe` Workers.PATCH
                urlText (Workers.requestURL request) `shouldBe` "https://internal.example/items?value=a%2Fb"
                headersToList (Workers.requestHeaders request) `shouldBe` [("x-test", "first"), ("x-test", "second")]
                case Workers.requestBodyReader request of
                    Nothing -> expectationFailure "Request body was dropped"
                    Just readBody -> readBody maxBound `shouldReturn` Right "\NUL\255payload"
    it "keeps a bodyless request bodyless" $ do
        outcome <- buildServiceRequest "https://internal.example/" "HEAD" (headersFromList []) Nothing
        case outcome of
            Left failure -> expectationFailure (show failure)
            Right request -> do
                Workers.requestMethod request `shouldBe` Workers.HEAD
                headersToList (Workers.requestHeaders request) `shouldBe` []
                case Workers.requestBodyReader request of
                    Nothing -> pure ()
                    Just _ -> expectationFailure "Unexpected request body"
    it "preserves lazy request bytes" $ do
        outcome <- buildServiceRequest "https://internal.example/" "POST" (headersFromList []) (Just (RequestBodyLBS "lazy payload"))
        case outcome of
            Right request | Just readBody <- Workers.requestBodyReader request -> do
                Workers.requestMethod request `shouldBe` Workers.POST
                headersToList (Workers.requestHeaders request) `shouldBe` []
                readBody maxBound `shouldReturn` Right "lazy payload"
            _ -> expectationFailure "Request body was dropped"
    it "preserves non-success status, duplicate headers and binary response bytes" $
        workersResponseToStreamingResponse
            (Workers.createResponse (Workers.Status 409)
                (headersFromList [("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")])
                (Workers.ResponseBodyLazyBytes "\NUL\255conflict")) $ \response -> do
            statusCode (responseStatusCode response) `shouldBe` 409
            responseHeaders response `shouldBe` Seq.fromList [("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")]
            runExceptT (SourceT.runSourceT (responseBody response)) `shouldReturn` Right ["\NUL\255conflict"]
    it "accepts empty 204 responses without reconstructing an invalid JavaScript body" $
        workersResponseToStreamingResponse
            (Workers.createResponse (Workers.Status 204) (headersFromList []) (Workers.ResponseBodyBytes "")) $ \response -> do
            statusCode (responseStatusCode response) `shouldBe` 204
            runExceptT (SourceT.runSourceT (responseBody response)) `shouldReturn` Right [""]

    it "rejects invalid targets before trying to evaluate a request stream" $ do
        result <- buildServiceRequest "" "GET" (headersFromList []) (Just (RequestBodySource (error "must not evaluate invalid-target body")))
        case result of
            Left failure -> failure `shouldBe` "Invalid Service Binding request URL"
            Right _ -> expectationFailure "Invalid URL was accepted"
    it "preserves extension methods without silently changing the verb" $ do
        result <- buildServiceRequest "https://internal.example/" "CUSTOM" (headersFromList []) Nothing
        case result of
            Left failure -> expectationFailure (show failure)
            Right request -> do
                Workers.requestMethod request `shouldBe` Workers.methodFromText "CUSTOM"
                headersToList (Workers.requestHeaders request) `shouldBe` []
    it "preserves lazy response chunk boundaries and callback results" $ do
        result <- workersResponseToStreamingResponse
            (Workers.createResponse (Workers.Status 200) (headersFromList []) (Workers.ResponseBodyLazyBytes (LBS.fromChunks ["first", "second"]))) $ \response -> do
                statusCode (responseStatusCode response) `shouldBe` 200
                runExceptT (SourceT.runSourceT (responseBody response)) `shouldReturn` Right ["first", "second"]
                pure (42 :: Int)
        result `shouldBe` 42

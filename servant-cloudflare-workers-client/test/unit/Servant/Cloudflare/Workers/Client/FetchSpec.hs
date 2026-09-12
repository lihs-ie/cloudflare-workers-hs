module Servant.Cloudflare.Workers.Client.FetchSpec (spec) where

import Control.Exception (fromException, try, displayException, throwIO, backtraceDesired)
import Control.Applicative (liftA2)
import Control.Monad.IO.Class (liftIO)
import Data.IORef (modifyIORef', newIORef, readIORef)
import Network.HTTP.Media ((//))
import Servant.Types.SourceT qualified as SourceT
import Data.Sequence qualified as Seq
import Hedgehog (assert, forAll, property, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Network.HTTP.Types (http11, mkStatus)
import Servant.Client.Core (BaseUrl (..), ClientError (..), ResponseF (..), Scheme (..), RequestF (..), RequestBody (..), RunClient (throwClientError), defaultRequest)
import Servant.Cloudflare.Workers.Client.Fetch
import Test.Syd
import Test.Syd.Hedgehog ()

spec :: Spec
spec = describe "Fetch policy" $ do
    it "accepts precisely 2xx by default" $ property $ do
        code <- forAll $ Gen.int (Range.linear 100 599)
        isAcceptableStatus Nothing (mkStatus code "") === (code >= 200 && code < 300)
    it "explicit acceptance replaces default success" $ do
        isAcceptableStatus (Just [mkStatus 404 ""]) (mkStatus 404 "") `shouldBe` True
        isAcceptableStatus (Just []) (mkStatus 200 "") `shouldBe` False
    it "normalization is bounded and idempotent" $ property $ do
        timeout <- forAll $ Gen.int Range.constantBounded
        retries <- forAll $ Gen.int Range.constantBounded
        delay <- forAll $ Gen.int Range.constantBounded
        let normalized = normalizeFetchClientOptions (FetchClientOptions timeout retries delay)
        normalizeFetchClientOptions normalized === normalized
        assert $ fetchClientOptionsTimeoutMillis normalized >= minimumFetchTimeoutMilliseconds
        assert $ fetchClientOptionsTimeoutMillis normalized <= maximumFetchTimeoutMilliseconds
        assert $ fetchClientOptionsMaxRetryAttempts normalized >= 0
        assert $ fetchClientOptionsRetryBaseDelayMillis normalized >= 0
        assert $ fetchClientOptionsRetryBaseDelayMillis normalized <= maximumRetryBackoffDelayMilliseconds
    it "backoff doubles and saturates without overflow" $ do
        map (retryBackoffDelayMilliseconds 250) [0, 1, 2, 8, 100] `shouldBe` [250, 500, 1000, 60000, 60000]
        retryBackoffDelayMilliseconds maxBound maxBound `shouldBe` 60000
        retryBackoffDelayMilliseconds (-1) 1 `shouldBe` 0
        retryBackoffDelayMilliseconds 10 (-1) `shouldBe` 10
    it "classifies errors and only retries transient failures" $ do
        classifyFetchTransportError "timeout" "secret" `shouldBe` FetchTimedOut
        classifyFetchTransportError "subrequest-limit" "secret" `shouldBe` FetchSubrequestLimitExceeded
        classifyFetchTransportError "unknown" "message" `shouldBe` FetchNetworkFailure "message"
        map shouldRetryTransportError [FetchTimedOut, FetchNetworkFailure "x", FetchSubrequestLimitExceeded] `shouldBe` [True, True, False]
    it "does not treat mutation methods as idempotent" $ do
        map isIdempotentMethod ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "POST", "PATCH"] `shouldBe` [True, True, True, True, True, False, False]
    it "threads the base URL through functor, applicative and monad" $ do
        let baseURL = BaseUrl Https "example.com" 443 ""
            current = FetchClient pure
        runFetchClient (fmap baseUrlHost current) baseURL `shouldReturn` "example.com"
        runFetchClient ((,) <$> current <*> pure (7 :: Int)) baseURL `shouldReturn` (baseURL, 7)
        runFetchClient (current >>= \url -> pure (baseUrlHost url)) baseURL `shouldReturn` "example.com"
    it "preserves transport error types inside ConnectionError" $ do
        case classifyEnvelopeFailure ("timeout", "ignored") of
            ConnectionError exception -> fromException exception `shouldBe` Just FetchTimedOut
            other -> expectationFailure (show other)
        map fetchTransportErrorConstructorName [FetchTimedOut, FetchSubrequestLimitExceeded, FetchNetworkFailure "detail"] `shouldBe` ["FetchTimedOut", "FetchSubrequestLimitExceeded", "FetchNetworkFailure"]
    it "throws FailureResponse only for rejected status codes" $ do
        let baseURL = BaseUrl Https "example.com" 443 ""
            response = Response (mkStatus 404 "Not Found") Seq.empty http11 "missing"
        outcome <- try @ClientError (throwUnlessAcceptableStatus Nothing baseURL defaultRequest response)
        case outcome of
            Left (FailureResponse captured actual) -> do
                requestPath captured `shouldBe` (baseURL, mempty)
                actual `shouldBe` response
            other -> expectationFailure (show other)
        throwUnlessAcceptableStatus (Just [mkStatus 404 "Not Found"]) baseURL defaultRequest response

    it "distinguishes absent and buffered bodies from one-shot streaming bodies" $ do
        let withBody body = defaultRequest{requestBody = Just (body, "application" // "octet-stream")}
        map requestBodyIsStreaming
            [ defaultRequest
            , withBody (RequestBodyBS "")
            , withBody (RequestBodyLBS "payload")
            , withBody (RequestBodySource (SourceT.source ["chunk"]))
            ] `shouldBe` [False, False, False, True]
    it "does not retry noncanonical or extension method spellings" $
        map isIdempotentMethod ["get", "Get", "CONNECT", "CUSTOM", ""] `shouldBe` replicate 5 False
    it "preserves all transport error variants in ConnectionError" $
        mapM_ (\(kind, message, expected) ->
            case classifyEnvelopeFailure (kind, message) of
                ConnectionError exception -> fromException exception `shouldBe` Just expected
                other -> expectationFailure (show other))
            [("subrequest-limit", "ignored", FetchSubrequestLimitExceeded), ("network", "connection reset", FetchNetworkFailure "connection reset"), ("malformed-envelope", "missing value", FetchNetworkFailure "missing value")]
    it "executes lifted effects exactly once and preserves thrown ClientError" $ do
        counter <- newIORef (0 :: Int)
        let baseURL = BaseUrl Https "example.com" 443 ""
        runFetchClient (liftIO (modifyIORef' counter (+ 1)) >> pure (7 :: Int)) baseURL `shouldReturn` 7
        readIORef counter `shouldReturn` 1
        outcome <- try @ClientError (runFetchClient (throwClientError (classifyEnvelopeFailure ("timeout", "")) :: FetchClient ()) baseURL)
        case outcome of
            Left (ConnectionError exception) -> fromException exception `shouldBe` Just FetchTimedOut
            other -> expectationFailure (show other)
    it "keeps the request path and base URL in rejected-response diagnostics" $ do
        let baseURL = BaseUrl Https "example.com" 8443 "/api"
            request = defaultRequest{requestPath = "/items/%2F", requestBody = Just (RequestBodyBS "sensitive", "application" // "json")}
            response = Response (mkStatus 503 "Unavailable") Seq.empty http11 "unavailable"
        case createFailureResponseError baseURL request response of
            FailureResponse captured actual -> do
                requestPath captured `shouldBe` (baseURL, "/items/%2F")
                requestBody captured `shouldBe` Just ((), "application" // "json")
                actual `shouldBe` response
            other -> expectationFailure (show other)

    it "preserves effects and selected values for default instance methods" $ do
        calls <- newIORef ([] :: [Int])
        let action value = liftIO (modifyIORef' calls (<> [value])) >> pure value
            baseURL = BaseUrl Https "example.com" 443 ""
        runFetchClient (7 <$ action 1) baseURL `shouldReturn` (7 :: Int)
        runFetchClient (liftA2 (+) (action 2) (action 3)) baseURL `shouldReturn` 5
        runFetchClient (action 4 *> action 5) baseURL `shouldReturn` 5
        runFetchClient (action 6 <* action 7) baseURL `shouldReturn` 6
        readIORef calls `shouldReturn` [1, 2, 3, 4, 5, 6, 7]
    it "compares normalized configurations and preserves typed exception diagnostics" $ do
        let options = normalizeFetchClientOptions (FetchClientOptions 0 (-1) (-1))
            rendered = "FetchClientOptions {fetchClientOptionsTimeoutMillis = 1, fetchClientOptionsMaxRetryAttempts = 0, fetchClientOptionsRetryBaseDelayMillis = 0}"
            errors = [FetchTimedOut, FetchSubrequestLimitExceeded, FetchNetworkFailure "detail"]
        options `shouldBe` FetchClientOptions 1 0 0
        (options /= defaultFetchClientOptions) `shouldBe` True
        show options `shouldBe` rendered
        show [options] `shouldBe` "[" <> rendered <> "]"
        errors `shouldBe` [FetchTimedOut, FetchSubrequestLimitExceeded, FetchNetworkFailure "detail"]
        (FetchNetworkFailure "detail" /= FetchNetworkFailure "other") `shouldBe` True
        map show errors `shouldBe` ["FetchTimedOut", "FetchSubrequestLimitExceeded", "FetchNetworkFailure \"detail\""]
        show errors `shouldBe` "[FetchTimedOut,FetchSubrequestLimitExceeded,FetchNetworkFailure \"detail\"]"
        result <- try @FetchTransportError (throwIO (FetchNetworkFailure "detail") :: IO ())
        either displayException (const "unexpected") result `shouldBe` "FetchNetworkFailure \"detail\""
        backtraceDesired FetchTimedOut `shouldBe` True

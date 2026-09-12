module Support.Runtime.ClientRetryExtra (runClientRetryExtra) where

import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding (..))
import Cloudflare.Workers.Headers (headersFromList, headersToList, headerLookup)
import Cloudflare.Workers.HTTP qualified as Workers
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, try, throwIO, backtraceDesired)
import Control.Applicative (liftA2)
import Cloudflare.Workers.Streaming (readableStreamToLazyByteString)
import Control.Monad.Trans.Except (runExceptT)
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as LBS
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Encoding
import GHC.Wasm.Prim (JSVal)
import Network.HTTP.Media ((//))
import Network.HTTP.Types (http11, mkStatus, statusCode, statusMessage)
import Servant.Client.Core
import Servant.Cloudflare.Workers.Client.Fetch
import Servant.Cloudflare.Workers.Client.Fetch.Request (buildFetchTargetURL, requestHeadersToWorkersHeaders)
import Servant.Cloudflare.Workers.Client.Internal.FFI.Fetch (workersResponseToStreamingResponse, buildServiceRequest)
import Servant.Types.SourceT qualified as SourceT
import Data.Sequence qualified as Seq

-- | Observe public policy values and response metadata, not only body effects.
runClientRetryExtra :: JSVal -> JSVal -> IO JSVal
runClientRetryExtra rawBinding rawMode = do
    mode <- jsValToText rawMode
    outcome <- try @SomeException (action mode)
    textToJSVal $ Encoding.decodeUtf8 $ LBS.toStrict $ Aeson.encode $ case outcome of
        Left failure -> Aeson.object ["ok" Aeson..= False, "message" Aeson..= displayException failure]
        Right value -> Aeson.object ["ok" Aeson..= True, "value" Aeson..= value]
  where
    baseURL = BaseUrl Https "service.example" 443 "/api"
    action "query-fields" = do
        let request = defaultRequest
                { requestQueryString = Seq.fromList [("a&b", Just "first%20value"), ("flag", Nothing), ("empty", Just "")]
                , requestHeaders = Seq.fromList [("X-Malformed", "\255")]
                }
        pure $ Aeson.object
            [ "url" Aeson..= buildFetchTargetURL baseURL request
            , "header" Aeson..= headerLookup "x-malformed" (requestHeadersToWorkersHeaders request)
            ]
    action "request-fields" = do
        result <- buildServiceRequest "https://service.example/source" "POST" (headersFromList [])
            (Just (RequestBodySource (SourceT.source ["first", "second"])))
        request <- either (throwIO . userError . Text.unpack) pure result
        body <- case Workers.requestBody request of
            Nothing -> throwIO (userError "Source request lost stream")
            Just stream -> readableStreamToLazyByteString 64 stream >>= either (throwIO . userError . show) pure
        pure $ Aeson.object
            [ "method" Aeson..= show (Workers.requestMethod request)
            , "headers" Aeson..= headersToList (Workers.requestHeaders request)
            , "readerAbsent" Aeson..= (case Workers.requestBodyReader request of Nothing -> True; Just _ -> False)
            , "dataCenter" Aeson..= Workers.requestDataCenter request
            , "body" Aeson..= Encoding.decodeUtf8 (LBS.toStrict body)
            ]
    action "instances" = do
        let dispatch = responseBody <$> runRequestAcceptStatus Nothing defaultRequest
            run client = runFetchClientWithServiceBinding client (ServiceBinding rawBinding) baseURL
        replaced <- run ("selected" <$ dispatch)
        combined <- run (liftA2 (<>) dispatch dispatch)
        right <- run (dispatch *> dispatch)
        left <- run (dispatch <* dispatch)
        pure $ Aeson.object
            [ "replaced" Aeson..= Encoding.decodeUtf8 (LBS.toStrict replaced)
            , "combined" Aeson..= Encoding.decodeUtf8 (LBS.toStrict combined)
            , "right" Aeson..= Encoding.decodeUtf8 (LBS.toStrict right)
            , "left" Aeson..= Encoding.decodeUtf8 (LBS.toStrict left)
            ]
    action "derived" = do
        let options = normalizeFetchClientOptions (FetchClientOptions 0 (-1) (-1))
            errors = [FetchTimedOut, FetchSubrequestLimitExceeded, FetchNetworkFailure "detail"]
        caught <- try @FetchTransportError (throwIO (FetchNetworkFailure "detail"))
        pure $ Aeson.object
            [ "optionsEqual" Aeson..= (options == FetchClientOptions 1 0 0)
            , "optionsDistinct" Aeson..= (options /= defaultFetchClientOptions)
            , "optionsShow" Aeson..= show options
            , "optionsList" Aeson..= show [options]
            , "errorsEqual" Aeson..= (errors == [FetchTimedOut, FetchSubrequestLimitExceeded, FetchNetworkFailure "detail"])
            , "errorsDistinct" Aeson..= (FetchNetworkFailure "detail" /= FetchNetworkFailure "other")
            , "errorsShow" Aeson..= map show errors
            , "errorsList" Aeson..= show errors
            , "caught" Aeson..= either displayException (const "unexpected") (caught :: Either FetchTransportError ())
            , "backtrace" Aeson..= backtraceDesired FetchTimedOut
            ]
    action "policy" = pure $ Aeson.object
        [ "delays" Aeson..= map (retryBackoffDelayMilliseconds 60000) [0, 1, 100]
        , "constructor" Aeson..= fetchTransportErrorConstructorName FetchSubrequestLimitExceeded
        ]
    action "diagnostic" = do
        let request = defaultRequest{requestPath = "/items/%2F", requestMethod = "PUT", requestBody = Just (RequestBodyBS "private", "application" // "json")}
            response = Response (mkStatus 503 "Unavailable") Seq.empty http11 "failure"
        pure $ case createFailureResponseError baseURL request response of
            FailureResponse captured actual -> Aeson.object
                [ "path" Aeson..= Encoding.decodeUtf8 (snd (requestPath captured))
                , "host" Aeson..= baseUrlHost (fst (requestPath captured))
                , "bodyErased" Aeson..= (requestBody captured == Just ((), "application" // "json"))
                , "status" Aeson..= statusCode (responseStatusCode actual)
                ]
            _ -> Aeson.Null
    action "buffered-metadata" = do
        response <- fetchWithOptions (FetchClientOptions 1000 0 0) Nothing baseURL defaultRequest
        pure $ Aeson.object
            [ "status" Aeson..= statusCode (responseStatusCode response)
            , "reason" Aeson..= Encoding.decodeUtf8 (statusMessage (responseStatusCode response))
            , "body" Aeson..= Encoding.decodeUtf8 (LBS.toStrict (responseBody response))
            ]
    action "passthrough" = workersResponseToStreamingResponse
        (Workers.createResponse (Workers.Status 200) (headersFromList []) (Workers.ResponseBodyPassthrough (Workers.PassthroughResponse rawBinding))) consume
    action mode = do
        let global = Text.isPrefixOf "global-" mode
            body = if Text.isSuffixOf "lazy" mode then RequestBodyLBS (LBS.fromChunks ["lazy-", "stream"]) else RequestBodyBS "strict-stream"
            request = defaultRequest{requestMethod = "POST", requestBody = Just (body, "application" // "octet-stream")}
            client = withStreamingRequest request consume
        if global then runFetchClient client baseURL else runFetchClientWithServiceBinding client (ServiceBinding rawBinding) baseURL
    consume response = do
        body <- runExceptT (SourceT.runSourceT (responseBody response))
        pure $ Aeson.object
            [ "status" Aeson..= statusCode (responseStatusCode response)
            , "reason" Aeson..= Encoding.decodeUtf8 (statusMessage (responseStatusCode response))
            , "body" Aeson..= either Text.pack (Encoding.decodeUtf8 . LBS.toStrict . LBS.fromChunks) body
            ]

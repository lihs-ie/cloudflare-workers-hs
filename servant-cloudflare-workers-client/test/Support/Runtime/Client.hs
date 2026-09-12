-- | Real-WASM fixture for Servant Service Binding dispatch and scoped bodies.
-- The JavaScript harness supplies a native fetch-capable binding so it can
-- observe cancellation, registration count, and recovery on subsequent calls.
module Support.Runtime.Client (runClientService) where

import Cloudflare.Workers.HTTP qualified as Workers
import Cloudflare.Workers.Headers (headersFromList)
import Servant.Cloudflare.Workers.Client.Internal.FFI.Fetch (workersResponseToStreamingResponse, serviceFetchStreamingViaFFI)
import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding (..))
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, throwIO, try)
import Control.Monad.IO.Class (liftIO)
import Network.HTTP.Types.Status (mkStatus, statusCode)
import Network.HTTP.Media ((//))
import Control.Monad.Trans.Except (runExceptT)
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as LBS
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Encoding
import Data.Text.Encoding.Error (lenientDecode)
import GHC.Wasm.Prim (JSVal)
import Servant.Client.Core (BaseUrl (..), Scheme (..), RunClient (runRequestAcceptStatus), RunStreamingClient (withStreamingRequest), ResponseF (responseBody, responseStatusCode), RequestF (requestBody, requestMethod), RequestBody (..), defaultRequest)
import Servant.Cloudflare.Workers.Client.Fetch (FetchClient (runFetchClient), FetchClientOptions (..), fetchWithOptions, runFetchClientWithServiceBinding)
import Servant.Types.SourceT qualified as SourceT

-- | Buffered/streaming responses, callback cleanup, and request producers run
-- through the supplied Service Binding. Prefix a mode with @global-@ to run it
-- through global fetch instead. The retry and no-retry-post modes always use
-- global fetch with short, bounded retry options.
-- Every Haskell exception is encoded as data, permitting a second call into
-- the same reactor after a failed call.
runClientService :: JSVal -> JSVal -> IO JSVal
runClientService rawBinding rawMode = do
    mode <- jsValToText rawMode
    let (useGlobal, selectedMode) = case Text.stripPrefix "global-" mode of
            Just selected -> (True, selected)
            Nothing -> (False, mode)
        run = if useGlobal then runFetchClient else (\client -> runFetchClientWithServiceBinding client (ServiceBinding rawBinding))
    outcome <- try @SomeException (run (action selectedMode) baseURL)
    textToJSVal $ Encoding.decodeUtf8 $ LBS.toStrict $ Aeson.encode $ case outcome of
        Left failure -> Aeson.object ["ok" Aeson..= False, "message" Aeson..= displayException failure]
        Right value -> Aeson.object ["ok" Aeson..= True, "value" Aeson..= value]
  where
    baseURL = BaseUrl Https "service.example" 443 "/"
    action :: Text.Text -> FetchClient Text.Text
    action "buffered" = bodyText . responseBody <$> runRequestAcceptStatus Nothing defaultRequest
    action "drain" = withStreamingRequest defaultRequest $ \response -> do
        result <- runExceptT (SourceT.runSourceT (responseBody response))
        either (throwIO . userError) (pure . bodyText . LBS.fromChunks) result
    action "strict-request" = bodyText . responseBody <$> runRequestAcceptStatus Nothing (bufferedRequest (RequestBodyBS "strict-body"))
    action "lazy-request" = bodyText . responseBody <$> runRequestAcceptStatus Nothing (bufferedRequest (RequestBodyLBS (LBS.fromChunks ["lazy-", "body"])))
    action "invalid-service-target" = liftIO $ do
        result <- serviceFetchStreamingViaFFI (ServiceBinding rawBinding) "" "GET" (headersFromList []) Nothing (\_ -> pure "unexpected")
        either (throwIO . userError . show) pure result
    action "websocket-response" = liftIO $ convertResponse (Workers.ResponseBodyWebSocket (Workers.PassthroughResponse rawBinding))
    action "strict-response" = liftIO $ convertResponse (Workers.ResponseBodyBytes "strict-response")
    action "lazy-response" = liftIO $ convertResponse (Workers.ResponseBodyLazyBytes (LBS.fromChunks ["lazy-", "response"]))
    action "retry" = liftIO $ bodyText . responseBody <$> fetchWithOptions (FetchClientOptions 25 2 1) Nothing baseURL defaultRequest
    action "stream-put" = liftIO $ bodyText . responseBody <$> fetchWithOptions (FetchClientOptions 25 2 1) Nothing baseURL (streamRequest False){requestMethod = "PUT"}
    action "buffered-put" = liftIO $ bodyText . responseBody <$> fetchWithOptions (FetchClientOptions 25 2 1) Nothing baseURL (bufferedRequest (RequestBodyBS "repeatable")){requestMethod = "PUT"}
    action "zero-retry" = liftIO $ bodyText . responseBody <$> fetchWithOptions (FetchClientOptions 25 0 1) Nothing baseURL defaultRequest
    action "negative-retry" = liftIO $ bodyText . responseBody <$> fetchWithOptions (FetchClientOptions 25 (-1) 1) Nothing baseURL defaultRequest
    action "accept-418" = bodyText . responseBody <$> runRequestAcceptStatus (Just [mkStatus 418 "Teapot"]) defaultRequest
    action "accept-none" = bodyText . responseBody <$> runRequestAcceptStatus (Just []) defaultRequest
    action "composed" = do
        first <- (\a b -> bodyText (responseBody a) <> bodyText (responseBody b)) <$> runRequestAcceptStatus Nothing defaultRequest <*> runRequestAcceptStatus Nothing defaultRequest
        lastResponse <- runRequestAcceptStatus Nothing defaultRequest
        pure (first <> bodyText (responseBody lastResponse))
    action "no-retry-post" = liftIO $ bodyText . responseBody <$> fetchWithOptions (FetchClientOptions 25 2 1) Nothing baseURL defaultRequest{requestMethod = "POST"}
    action "stream-request" = bodyText . responseBody <$> runRequestAcceptStatus Nothing (streamRequest False)
    action "stream-request-error" = bodyText . responseBody <$> runRequestAcceptStatus Nothing (streamRequest True)
    action "throw" = withStreamingRequest defaultRequest $ \_ -> throwIO (userError "client callback failed")
    action "abandon" = withStreamingRequest defaultRequest $ \_ -> pure "abandoned"
    action unknownMode = liftIO $ throwIO (userError ("Unknown client fixture mode: " <> Text.unpack unknownMode))
    bodyText = Encoding.decodeUtf8With lenientDecode . LBS.toStrict

    streamRequest failAfterChunk = defaultRequest
        { requestMethod = "POST"
        , requestBody = Just (RequestBodySource (SourceT.SourceT (\consume -> consume steps)), "application" // "octet-stream")
        }
      where
        steps = SourceT.Skip (SourceT.Effect (pure (SourceT.Yield "" (SourceT.Yield "first" ending))))
        ending = if failAfterChunk then SourceT.Error "client request producer failed" else SourceT.Yield "second" SourceT.Stop

    bufferedRequest body = defaultRequest{requestMethod = "POST", requestBody = Just (body, "application" // "octet-stream")}
    convertResponse body = workersResponseToStreamingResponse (Workers.createResponse (Workers.Status 200) (headersFromList []) body) $ \response -> do
        result <- runExceptT (SourceT.runSourceT (responseBody response))
        bytes <- either (throwIO . userError) pure result
        pure (Text.pack (show (statusCode (responseStatusCode response))) <> ":" <> bodyText (LBS.fromChunks bytes))

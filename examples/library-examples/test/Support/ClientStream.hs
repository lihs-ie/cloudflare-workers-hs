module Support.ClientStream (clientStreamLifecycle, clientHTTPStreamLifecycle, clientUploadLifecycle) where

import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding(..))
import ExampleSupport.Interop (textToJSVal, jsValToText)
import Control.Exception (SomeException, displayException, try, finally, fromException)
import Control.Concurrent (threadDelay)
import Data.IORef
import Control.Monad.Trans.Except (runExceptT)
import Data.Aeson (encode, object, (.=))
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as Lazy
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)
import Data.Proxy (Proxy(..))
import Servant.API (OctetStream, contentType)
import Servant.Client.Core (ClientError(..), RequestF(..), RequestBody(..), BaseUrl(..), Scheme(..), RunStreamingClient(..), ResponseF(..), defaultRequest, parseBaseUrl)
import Servant.Cloudflare.Workers.Client.Fetch (runFetchClientWithServiceBinding, runFetchClient, fetchWithOptions, FetchClientOptions(..), FetchTransportError, fetchTransportErrorConstructorName)
import Servant.Types.SourceT qualified as SourceT

-- Exercise the public callback lifetime, retaining the native stream in JS so
-- the test can inspect its lock and cancellation after the callback exits.
clientStreamLifecycle :: JSVal -> Int -> IO JSVal
clientStreamLifecycle binding mode = do
    outcome <- try @SomeException $ runFetchClientWithServiceBinding
        (withStreamingRequest defaultRequest $ \response -> do
            if mode == 2 then fail "consumer failed before reading" else pure ()
            chunks <- if mode == 1 || mode == 3
                then firstChunk (responseBody response)
                else either fail pure =<< runExceptT (SourceT.runSourceT (responseBody response))
            if mode == 3 then fail "consumer failed after reading" else pure chunks)
        (ServiceBinding binding) (BaseUrl Https "fixture.invalid" 443 "")
    let result = case outcome of
            Left failure -> object ["error" .= displayException failure]
            Right chunks -> object ["bytes" .= Bytes.unpack (Bytes.concat chunks)]
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode result)))
  where
    firstChunk source = SourceT.unSourceT source step
    step SourceT.Stop = pure []
    step (SourceT.Error message) = fail message
    step (SourceT.Skip rest) = step rest
    step (SourceT.Effect action) = action >>= step
    step (SourceT.Yield bytes _) = pure [bytes]

-- Native HTTP response that remains open after its first chunk. Returning from
-- the callback must cancel the upstream body, not leave an active connection.
clientHTTPStreamLifecycle :: JSVal -> IO JSVal
clientHTTPStreamLifecycle origin = do
    target <- parseBaseUrl . Text.unpack =<< jsValToText origin
    chunks <- runFetchClient
        (withStreamingRequest defaultRequest $ \response ->
            SourceT.unSourceT (responseBody response) firstChunk)
        target{baseUrlPath = "/stream-response"}
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode
        (object ["bytes" .= Bytes.unpack (Bytes.concat chunks)]))))
  where
    firstChunk SourceT.Stop = pure []
    firstChunk (SourceT.Error message) = fail message
    firstChunk (SourceT.Skip rest) = firstChunk rest
    firstChunk (SourceT.Effect action) = action >>= firstChunk
    firstChunk (SourceT.Yield bytes _) = pure [bytes]

-- Finite delayed producer makes cancellation observable independently of the
-- transport error. The finally belongs to traversal, not source construction.
clientUploadLifecycle :: JSVal -> IO JSVal
clientUploadLifecycle origin = do
    target <- parseBaseUrl . Text.unpack =<< jsValToText origin
    stopped <- newIORef False
    generated <- newIORef (0 :: Int)
    let step 10 = SourceT.Stop
        step index = SourceT.Effect $ do
            if index > 0 then threadDelay 100000 else pure ()
            modifyIORef' generated (+ 1)
            pure (SourceT.Yield (Lazy.pack [0, 128, 255]) (step (index + 1)))
        source = SourceT.SourceT $ \consume -> consume (step (0 :: Int)) `finally` writeIORef stopped True
        request = defaultRequest
            { requestMethod = "PUT"
            , requestHeaders = pure ("X-Stream-Trace", "upload-lifecycle")
            , requestBody = Just (RequestBodySource source, contentType (Proxy @OctetStream))
            }
    outcome <- try @ClientError (fetchWithOptions (FetchClientOptions 3000 2 0) Nothing
        target{baseUrlPath = "/stream-upload"} request)
    atResponse <- readIORef generated
    let wait 0 = pure ()
        wait remaining = do
            done <- readIORef stopped
            if done then pure () else threadDelay 10000 >> wait (remaining - 1)
    wait (200 :: Int)
    done <- readIORef stopped
    count <- readIORef generated
    let result = case outcome of
            Right _ -> "success"
            Left (ConnectionError exception) -> maybe "unexpected-transport" fetchTransportErrorConstructorName (fromException @FetchTransportError exception)
            Left _ -> "unexpected-client-error"
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode (object
        [ "outcome" .= result, "stopped" .= done, "generated" .= count, "atResponse" .= atResponse ]))))

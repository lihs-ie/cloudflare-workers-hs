module Main (main) where

import Cloudflare.Workers.Entrypoint.Fetch (FetchHandler, JSFetchExport, createFetchHandler)
import Cloudflare.Workers.HTTP (
    Method (POST),
    Request (Request, requestBodyField, requestHeaders, requestMethodField, requestPathField),
    RequestBodyPlaceholder (RequestBodyPlaceholder),
    Response (Response, responseBody, responseHeaders, responseStatus),
    Status (Status),
    createResponse,
    requestBody,
    requestMethod,
    requestPath,
 )
import Cloudflare.Workers.Reactor (Context (Context), initializeRTS, passThroughOnException, waitUntil)
import Cloudflare.Workers.Streaming (ReadableStream (ReadableStream), lazyByteStringToReadableStream, readableStreamToLazyByteString)
import Data.ByteString.Char8 qualified as ByteString8
import Data.IORef (newIORef, readIORef, writeIORef)
import Data.Text qualified as Text
import Test.Tasty (TestTree, defaultMain, testGroup)
import Test.Tasty.HUnit (testCase, (@?=))

main :: IO ()
main = defaultMain tests

httpTests :: TestTree
httpTests =
    testGroup
        "Cloudflare.Workers.HTTP"
        [ testCase "requestMethod / requestPath / requestBody read back Request fields" $ do
            let sampleRequest =
                    Request
                        { requestMethodField = POST
                        , requestPathField = "/shorten"
                        , requestBodyField = ReadableStream
                        , requestHeaders = [("content-type", "application/json")]
                        }
            requestMethod sampleRequest @?= POST
            requestPath sampleRequest @?= "/shorten"
            requestBody sampleRequest @?= ReadableStream
        , testCase "mkResponse builds a Response from status/headers/body" $ do
            let response = createResponse (Status 200) [("content-type", "application/json")] (ByteString8.pack "{\"ok\":true}")
            responseStatus response @?= Status 200
            responseHeaders response @?= [("content-type", "application/json")]
            responseBody response @?= ByteString8.pack "{\"ok\":true}"
        ]

streamingTests :: TestTree
streamingTests =
    testGroup
        "Cloudflare.Workers.Streaming"
        [ testCase "readableStreamToLazyByteString / lazyByteStringToReadableStream round-trip the opaque stub without raising (host tier1; real JSVal marshalling lands in sec-8-02)" $ do
            intermediateBytes <- readableStreamToLazyByteString ReadableStream
            _roundTrippedStream <- lazyByteStringToReadableStream intermediateBytes
            pure ()
        ]

reactorTests :: TestTree
reactorTests =
    testGroup
        "Cloudflare.Workers.Reactor"
        [ testCase "initializeRTS is idempotent and waitUntil runs the deferred IO action" $ do
            initializeRTS
            initializeRTS
            ranFlag <- newIORef False
            waitUntil (writeIORef ranFlag True)
            ranValue <- readIORef ranFlag
            ranValue @?= True
        ]

entrypointFetchTests :: TestTree
entrypointFetchTests =
    testGroup
        "Cloudflare.Workers.Entrypoint.Fetch"
        [ testCase "mkFetchHandler wraps a FetchHandler into an opaque JSFetchExport (host stub; wasm export wiring lands in later sections)" $ do
            _jsFetchExport <- createFetchHandler dummyFetchHandler
            pure ()
        ]

dummyFetchHandler :: FetchHandler ()
dummyFetchHandler request _env _ctx =
    pure (createResponse (Status 200) [] (ByteString8.pack (Text.unpack (requestPath request))))

tests :: TestTree
tests =
    testGroup
        "cloudflare-workers"
        [httpTests, streamingTests, reactorTests, entrypointFetchTests]

isWebSocketUpgradeRequest :: Request -> Bool
isWebSocketUpgradeRequest request =
    any matchesUpgradeToWebSocket (requestHeaders request)
  where
    matchesUpgradeToWebSocket (name, value) =
        Text.toLower name == "upgrade" && Text.toLower value == "websocket"

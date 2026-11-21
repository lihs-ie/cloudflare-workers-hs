module Support.Runtime.Streaming (probeStreaming) where

import Cloudflare.Workers.Entrypoint.Fetch (FetchHandler, createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.HTTP (Response, ResponseBody (ResponseBodyLazyBytes), Status (Status), createResponse, requestBody, requestPath)
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Streaming
import Control.Exception (SomeException, displayException, throwIO, try)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

type ProbeEnv = BindingEnv '[] '[] '[]

probeStreaming :: JSVal -> JSVal -> JSVal -> IO JSVal
probeStreaming = createFetchHandler handleProbe

handleProbe :: FetchHandler ProbeEnv
handleProbe request _env _context = do
    outcome <- try @SomeException $ do
        let command = Text.drop (Text.length "/__fixture/stream/") (requestPath request)
        case command of
            "producer-throw" -> do
                stream <- readableStreamFromProducer (\_emit -> throwIO (userError "producer exploded"))
                drain 64 stream
            "producer-complete" -> do
                stream <- readableStreamFromProducer $ \emit -> do
                    _ <- emit "recovered"
                    pure StreamProducerCompleted
                drain 64 stream
            _ -> do
                stream <- maybe (fail "Stream probe requires an input body") pure (requestBody request)
                case command of
                    "fixed-negative" -> drain 64 =<< readableStreamWithLength (-1) stream
                    "fixed-unsafe" -> drain 64 =<< readableStreamWithLength 9007199254740992 stream
                    "fixed-valid" -> drain 64 =<< readableStreamWithLength 2 stream
                    "negative-limit" -> drain (-1) stream
                    "byte-limit" -> drain 1 stream
                    "cancel" -> readableStreamCancel stream >> pure (object ["cancelled" .= True])
                    "read-failure" -> drain 64 stream
                    _ -> fail "Unknown streaming probe"
    pure $ json $ either (\failure -> object ["failure" .= displayException failure]) id outcome

drain :: Int -> ReadableStream -> IO Value
drain limit stream = do
    result <- readableStreamToLazyByteString limit stream
    pure $ case result of
        Left failure -> object ["rejected" .= show failure]
        Right bytes -> object ["bytes" .= Lazy.unpack bytes]

json :: Value -> Response
json = createResponse (Status 200) (headersFromList [("content-type", "application/json")]) . ResponseBodyLazyBytes . encode

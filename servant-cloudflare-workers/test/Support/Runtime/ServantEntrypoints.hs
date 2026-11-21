module Support.Runtime.ServantEntrypoints where

import Support.Runtime.RoutingCoverage qualified as RoutingCoverage
import Cloudflare.Workers.Streaming qualified as Streaming
import Cloudflare.Workers.Binding.D1
import Support.Runtime.Routing qualified as Routing
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import WorkersSupport.Interop (byteStringToJSByteArray, decodeEnveloped, jsByteArrayToByteString, jsValToText, textToJSVal)
import Cloudflare.Workers.Reactor (WorkersExecutionContext(..), passThroughOnException, waitUntil)
import Data.Text qualified as Text
import Control.Exception (throwIO, try, SomeException, displayException)
import Data.Aeson qualified as Aeson
import Data.Aeson.Types (parseEither, (.:), (.:?), (.!=))
import Data.ByteString (ByteString)
import Data.Text.Encoding qualified as TextEncoding
import GHC.Wasm.Prim (JSVal)
import Trace.Hpc.Reflect (examineTix)

routingProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
routingProbe modeValue requestValue contextValue = do
    mode <- jsValToText modeValue
    createFetchHandler (\request (_ :: BindingEnv '[] '[] '[]) context -> Routing.routingFixture mode request context) requestValue contextValue contextValue


routingCoverageProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
routingCoverageProbe modeValue requestValue contextValue _streamValue = do
    mode <- jsValToText modeValue
    source <- Streaming.readableStreamFromProducer $ \emit -> do
      _ <- emit (routingCoverageStreamBody mode)
      pure Streaming.StreamProducerCompleted
    createFetchHandler (\request (_ :: BindingEnv '[] '[] '[]) context -> RoutingCoverage.routingCoverageFixture mode request context source) requestValue contextValue contextValue


routingCoverageStreamBody :: Text.Text -> ByteString
routingCoverageStreamBody mode = case mode of
  "custom-typeclass-stream" -> "custom-stream"
  "stream-context" -> "stream-body"
  "stream-headers" -> "download"
  _ -> ""

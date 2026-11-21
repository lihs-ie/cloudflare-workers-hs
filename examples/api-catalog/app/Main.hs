{-# LANGUAGE CPP #-}
module Main (main) where
#ifdef WASM_COVERAGE
import Trace.Hpc.Reflect (examineTix)
import Data.Text qualified as CoverageText
#endif
import Cloudflare.Workers.Binding.R2 (R2Bucket(..))
import Cloudflare.Workers.Binding.KV (KV(..))
import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding(..))
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Entrypoint.Tail
import Cloudflare.Workers.Env (BindingEnv, getDurableObjectNamespace)
import Cloudflare.Workers.Observability (tailLog)
import Cloudflare.Workers.Socket
import WorkersSupport.Interop (jsValToText, textToJSVal)
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import Data.Maybe (fromMaybe)
import Data.Proxy (Proxy(..))
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)
import Cloudflare.Workers.Binding.D1 (D1(..))
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace(..), DurableObjectStorage(..))
import Cloudflare.Workers.Binding.Secret (Secret(..))
import Data.Aeson (eitherDecodeStrict', toJSON)
import Control.Exception (throwIO)
import Servant.Client.Core (parseBaseUrl)
import ApiCatalog.Configuration qualified as Configuration
import ApiCatalog.SocketExamples (socketEndpoints)
import ApiCatalog.API (API)
import ApiCatalog.Application (server)
import Servant.Cloudflare.Workers.Server (serveWithContext, Context(..))

main :: IO ()
main = pure ()

fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
fetch request env context = do
  endpoints <- socketEndpoints env
  bucket <- R2Bucket <$> exampleBucket env
  kv <- KV <$> settingsBinding env
  service <- ServiceBinding <$> guideBinding env
  connector <- SocketConnector <$> socketConnector env
  database <- D1 <$> catalogDatabase env
  secretText <- attachmentKey env >>= jsValToText
  origin <- clientOrigin env >>= jsValToText
  clientBase <- parseBaseUrl (Text.unpack origin)
  let secret = if Text.null secretText then Nothing else Just (Secret secretText)
  createFetchHandler
    (Configuration.instrumented (\req (bindings :: Configuration.ConfigurationBindings) ctx -> serveWithContext (Proxy @API) EmptyContext (server database secret clientBase kv service connector bucket endpoints (Configuration.settingsFromBindings bindings)) req ctx ()))
    request env context
foreign export javascript "fetch" fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "$1.EXAMPLE_BUCKET" exampleBucket :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.SETTINGS" settingsBinding :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.GUIDE" guideBinding :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.SOCKET_CONNECT" socketConnector :: JSVal -> IO JSVal

tailEvents :: JSVal -> JSVal -> JSVal -> IO ()
tailEvents = createTailHandler (\events (_ :: BindingEnv '[] '[] '[]) _ ->
  mapM_ (\event -> tailLog ("tail outcome=" <> tailEventOutcome event <> " script=" <> fromMaybe "unknown" (tailEventScriptName event) <> " timestamp=" <> Text.pack (show (tailEventEventTimestamp event)))) events)
foreign export javascript "tail" tailEvents :: JSVal -> JSVal -> JSVal -> IO ()


foreign import javascript unsafe "$1.CATALOG_DB" catalogDatabase :: JSVal -> IO JSVal
foreign import javascript unsafe "typeof $1.ATTACHMENT_SSEC_KEY === 'string' ? $1.ATTACHMENT_SSEC_KEY : ''" attachmentKey :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.CLIENT_ORIGIN || 'http://127.0.0.1:1'" clientOrigin :: JSVal -> IO JSVal

#ifdef WASM_COVERAGE
coverage :: IO JSVal
coverage = examineTix >>= textToJSVal . CoverageText.pack . show
foreign export javascript "coverage" coverage :: IO JSVal
#endif

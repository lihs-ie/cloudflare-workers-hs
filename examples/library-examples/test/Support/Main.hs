{-# LANGUAGE CPP #-}
module Main (main) where
import Support.AttachmentRequest qualified as AttachmentRequest
import Support.LibraryExamples.Misc qualified as Misc
import Support.ClientDefaults qualified as ClientDefaults
import Support.JobsFailures qualified as JobsFailures
#ifdef WASM_COVERAGE
import Trace.Hpc.Reflect (examineTix)
import Data.Text qualified as CoverageText
#endif
import Cloudflare.Workers.HTTP (createResponse, Status(..), ResponseBody(..))
import Cloudflare.Workers.Headers (headersFromList)
import ExampleSupport.Interop (jsValToText, readableStreamFromJSVal, responseToJSVal, textToJSVal)
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler, FetchHandler)
import Cloudflare.Workers.Binding.KV
import Cloudflare.Workers.Socket
import Cloudflare.Workers.Streaming (readableStreamToLazyByteString)
import Control.Exception (SomeException, try, displayException, bracket)
import Control.Monad (void)
import Data.Aeson (encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)
import LibraryExamples.Configuration qualified as Configuration
import Cloudflare.Workers.Binding.R2 (R2Bucket(..))
import LibraryExamples.CachePurge qualified as CachePurge
import Support.QueueContracts (queueContract)
import Support.SocketFailures (runSocketFailure)
import Support.Storage (storageValidation)
import Support.LibraryExamples.R2Failures (runR2FailureScenario)
import Support.Database (databaseFailureRecovery)
import Support.ClientStream (clientStreamLifecycle, clientHTTPStreamLifecycle, clientUploadLifecycle)

main :: IO ()
main = pure ()

-- Native stream fixture bridge; no HTTP route is added to the production app.
drainStream :: JSVal -> Int -> IO JSVal
drainStream raw limit = do
  result <- try @SomeException (readableStreamToLazyByteString limit (readableStreamFromJSVal raw))
  let response = case result of
        Left exception -> object ["error" .= displayException exception]
        Right (Left failure) -> object ["outcome" .= show failure]
        Right (Right bytes) -> object ["bytes" .= Lazy.unpack bytes]
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode response)))
foreign export javascript "drainStream" drainStream :: JSVal -> Int -> IO JSVal

socketFailure :: JSVal -> IO JSVal
socketFailure connector = bracket
  (socketConnect (SocketConnector connector) (SocketAddressText "127.0.0.1:1") socketDefaultOptions)
  (void . socketClose)
  (\socket -> do
    opened <- socketOpened socket
    closed <- socketClosed socket
    state <- socketState socket
    let failed (Left _) = True
        failed _ = False
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode (object ["openedFailed" .= failed opened, "closedFailed" .= failed closed, "state" .= show state])))))
foreign export javascript "socketFailure" socketFailure :: JSVal -> IO JSVal

-- Exercise the production native Response marshaller, including null-body statuses.
emptyResponse :: Int -> Int -> IO JSVal
emptyResponse code variant = responseToJSVal (createResponse (Status code)
  (headersFromList [("X-Fixture", "retained")])
  (if variant == 0 then ResponseBodyBytes mempty else ResponseBodyLazyBytes mempty))
foreign export javascript "emptyResponse" emptyResponse :: Int -> Int -> IO JSVal

configurationFailure :: JSVal -> JSVal -> JSVal -> IO JSVal
configurationFailure = createFetchHandler (Configuration.instrumented failureHandler)
foreign export javascript "configurationFailure" configurationFailure :: JSVal -> JSVal -> JSVal -> IO JSVal

failureHandler :: FetchHandler Configuration.ConfigurationBindings
failureHandler _ _ _ = fail "fixture-sensitive-exception-marker"

-- Native KV JSON parsing must classify rejection without poisoning later reads.
kvMalformedJSONRecovery :: JSVal -> IO JSVal
kvMalformedJSONRecovery namespace = bracket (pure (KV namespace))
  (`kvDelete` "fixture:malformed-json-recovery")
  (\kv -> do
    let key = "fixture:malformed-json-recovery"
    kvPut kv key (KVPutText "{invalid-json") kvPutDefaultOptions
    rejected <- try @KVError (kvGet kv key KVReadJSON kvReadDefaultOptions)
    let classification = case rejected of
          Left (KVGetFailed _) -> "KVGetFailed"
          Left _ -> "unexpected-error"
          Right _ -> "unexpected-success"
    kvPut kv key (KVPutText "{\"recovered\":true}") kvPutDefaultOptions
    restored <- kvGet kv key KVReadJSON kvReadDefaultOptions
    let value = case restored of
          Just (KVJSONValue json) -> Just json
          _ -> Nothing
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode (object
      [ "classification" .= (classification :: String)
      , "json" .= value
      ])))))
foreign export javascript "kvMalformedJSONRecovery" kvMalformedJSONRecovery :: JSVal -> IO JSVal

foreign export javascript "clientStreamLifecycle" clientStreamLifecycle :: JSVal -> Int -> IO JSVal

foreign export javascript "clientHTTPStreamLifecycle" clientHTTPStreamLifecycle :: JSVal -> IO JSVal

foreign export javascript "clientUploadLifecycle" clientUploadLifecycle :: JSVal -> IO JSVal

foreign export javascript "databaseFailureRecovery" databaseFailureRecovery :: JSVal -> IO JSVal

r2Failure :: JSVal -> JSVal -> IO JSVal
r2Failure bucket rawMode = do
  mode <- jsValToText rawMode
  result <- runR2FailureScenario (R2Bucket bucket) mode
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode result)))
foreign export javascript "r2Failure" r2Failure :: JSVal -> JSVal -> IO JSVal
foreign export javascript "storageValidation" storageValidation :: JSVal -> JSVal -> IO JSVal

cachePurgeExample :: JSVal -> JSVal -> IO JSVal
cachePurgeExample = CachePurge.runCachePurge
foreign export javascript "cachePurgeExample" cachePurgeExample :: JSVal -> JSVal -> IO JSVal

socketBoundary :: JSVal -> JSVal -> JSVal -> IO JSVal
socketBoundary connector rawScenario rawAddress = do
  scenario <- jsValToText rawScenario
  address <- jsValToText rawAddress
  result <- runSocketFailure (SocketConnector connector) scenario address
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode result)))
foreign export javascript "socketBoundary" socketBoundary :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign export javascript "queueContract" queueContract :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

#ifdef WASM_COVERAGE
coverage :: IO JSVal
coverage = examineTix >>= textToJSVal . CoverageText.pack . show
foreign export javascript "coverage" coverage :: IO JSVal
#endif

clientDefaultOptions :: JSVal -> IO JSVal
clientDefaultOptions = ClientDefaults.clientDefaultOptions
foreign export javascript "clientDefaultOptions" clientDefaultOptions :: JSVal -> IO JSVal
jobsFailure :: JSVal -> JSVal -> JSVal -> IO JSVal
jobsFailure = JobsFailures.jobsFailure
foreign export javascript "jobsFailure" jobsFailure :: JSVal -> JSVal -> JSVal -> IO JSVal

attachmentMissingReader :: JSVal -> IO JSVal
attachmentMissingReader = AttachmentRequest.attachmentMissingReader
foreign export javascript "attachmentMissingReader" attachmentMissingReader :: JSVal -> IO JSVal
loggingUnknownRecovery :: IO JSVal
loggingUnknownRecovery = Misc.loggingUnknownRecovery
foreign export javascript "loggingUnknownRecovery" loggingUnknownRecovery :: IO JSVal

miscSocketFailure :: JSVal -> JSVal -> IO JSVal
miscSocketFailure = Misc.miscSocketFailure
foreign export javascript "miscSocketFailure" miscSocketFailure :: JSVal -> JSVal -> IO JSVal

miscStorageUnknown :: IO JSVal
miscStorageUnknown = Misc.miscStorageUnknown
foreign export javascript "miscStorageUnknown" miscStorageUnknown :: IO JSVal

clientOptionDiagnostics :: IO JSVal
clientOptionDiagnostics = ClientDefaults.clientOptionDiagnostics
foreign export javascript "clientOptionDiagnostics" clientOptionDiagnostics :: IO JSVal

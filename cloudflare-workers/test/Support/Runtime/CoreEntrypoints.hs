module Support.Runtime.CoreEntrypoints where

import Support.Runtime.StoragePublicContracts qualified as StoragePublicContracts
import Support.Runtime.EntrypointLifecycleErrors qualified as EntrypointLifecycleErrors
import Cloudflare.Workers.Streaming qualified as Streaming
import Support.Runtime.TransportExtra qualified as TransportExtra
import Support.Runtime.WorkflowBoundaryExtra qualified as WorkflowBoundaryExtra
import Support.Runtime.EntrypointErrors qualified as EntrypointErrors
import Support.Runtime.CacheServiceErrors qualified as CacheServiceErrors
import Support.Runtime.StorageObjectErrors qualified as StorageObjectErrors
import Support.Runtime.StorageErrors qualified as StorageErrors
import Cloudflare.Workers.Binding.D1
import Support.Runtime.BindingEnv qualified as BindingEnvProbe
import Support.Runtime.SQLBoundaries qualified as SQLBoundaries
import Support.Runtime.TypedQueueBoundaries qualified as TypedQueueBoundaries
import Support.Runtime.Envelope qualified as Envelope
import Support.Runtime.SocketStream qualified as SocketStream
import Support.Runtime.StorageBoundaries qualified as StorageBoundaries
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
import Support.Runtime.MiddlewareExtra qualified as MiddlewareExtra

handler :: Request -> BindingEnv '[] '[] '[] -> WorkersExecutionContext -> IO Response
handler request _ _ = pure $ createResponse (Status 200) (headersFromList [("X-Method", methodToText (requestMethod request))]) $
  maybe (ResponseBodyBytes "") ResponseBodyStream (requestBody request)

jsFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
jsFetch = createFetchHandler handler


storage :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
storage storageValue commandValue keyValue bytesValue = do
  command <- jsValToText commandValue
  key <- jsValToText keyValue
  let handle = DurableObjectStorage storageValue
  case command of
    "put" -> do
      bytes <- jsByteArrayToByteString bytesValue
      doStoragePut handle key bytes
      textToJSVal "ok"
    "get" -> do
      result <- doStorageGet handle key
      maybe (textToJSVal "absent") byteStringToJSByteArray result
    "delete" -> textToJSVal . Text.pack . show =<< doStorageDelete handle key
    "rollback" -> do
      bytes <- jsByteArrayToByteString bytesValue
      result <- doStorageTransaction handle [DurableObjectStorageOperationPut key bytes, DurableObjectStorageOperationFail]
      case result of
        Left _ -> textToJSVal "rolled-back"
        Right () -> error "Expected transaction failure"
    "transaction" -> do
      bytes <- jsByteArrayToByteString bytesValue
      either throwIO pure =<< doStorageTransaction handle [DurableObjectStorageOperationPut key bytes]
      textToJSVal "ok"
    _ -> error "unknown test operation"


d1Lookup :: JSVal -> JSVal -> IO JSVal
d1Lookup databaseValue keyValue = do
  key <- jsValToText keyValue
  statement <- d1Prepare (D1 databaseValue) "SELECT value FROM runtime_d1_lookup WHERE key = ?"
  bound <- d1Bind statement [D1Text key]
  row <- d1First bound
  case row of
    Nothing -> textToJSVal "absent"
    Just [("value", D1Text value)] -> textToJSVal value
    Just _ -> fail "D1 first returned an unexpected row shape"


coverage :: IO JSVal
coverage = examineTix >>= textToJSVal . Text.pack . show


observeContext :: IO () -> IO JSVal
observeContext action = do
  outcome <- try action
  textToJSVal $ either (Text.pack . displayException @SomeException) (const "ok") outcome

passThroughContext :: JSVal -> IO JSVal
passThroughContext = observeContext . passThroughOnException . WorkersExecutionContext


waitUntilContext :: JSVal -> JSVal -> IO JSVal
waitUntilContext context action = observeContext $ waitUntil (WorkersExecutionContext context) $ do
  result <- invokeContextAction action
  decodeEnveloped (const (pure ())) result >>= either (throwIO . userError . Text.unpack) pure
foreign import javascript safe "(async()=>{try{await $1();return {ok:true,value:null};}catch(error){return {ok:false,message:String(error)};}})()" invokeContextAction :: JSVal -> IO JSVal

envelopeProbe :: JSVal -> IO JSVal
envelopeProbe = Envelope.envelopeProbe


storageNativeProbe :: JSVal -> JSVal -> IO JSVal
storageNativeProbe = StorageBoundaries.storageNativeProbe


queueOutcome :: JSVal -> JSVal -> IO JSVal
queueOutcome = StorageBoundaries.queueOutcome


d1DecoderBoundaries :: IO JSVal
d1DecoderBoundaries = StorageBoundaries.d1DecoderBoundaries


socketProbe :: JSVal -> JSVal -> IO JSVal
socketProbe = SocketStream.socketProbe


bindingEnvProbe :: JSVal -> JSVal -> IO JSVal
bindingEnvProbe = BindingEnvProbe.bindingEnvProbe


middlewareExtraProbe :: JSVal -> JSVal -> IO JSVal
middlewareExtraProbe = MiddlewareExtra.middlewareExtraProbe


sqlProbe :: JSVal -> JSVal -> IO JSVal
sqlProbe = SQLBoundaries.sqlProbe


typedQueueProbe :: JSVal -> IO JSVal
typedQueueProbe = TypedQueueBoundaries.typedQueueProbe


storageErrorProbe :: JSVal -> JSVal -> IO JSVal
storageErrorProbe = StorageErrors.storageErrorProbe


storageObjectErrors :: JSVal -> JSVal -> IO JSVal
storageObjectErrors = StorageObjectErrors.storageObjectErrors


cacheServiceErrorsProbe :: JSVal -> JSVal -> IO JSVal
cacheServiceErrorsProbe = CacheServiceErrors.cacheServiceErrorsProbe


entrypointErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointErrorsProbe = EntrypointErrors.entrypointErrorsProbe


workflowBoundaryExtraProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
workflowBoundaryExtraProbe = WorkflowBoundaryExtra.workflowBoundaryExtraProbe


transportExtraProbe :: JSVal -> JSVal -> IO JSVal
transportExtraProbe = TransportExtra.transportExtraProbe


entrypointLifecycleErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointLifecycleErrorsProbe = EntrypointLifecycleErrors.entrypointLifecycleErrorsProbe


storagePublicContractsProbe :: JSVal -> IO JSVal
storagePublicContractsProbe = StoragePublicContracts.storagePublicContractsProbe

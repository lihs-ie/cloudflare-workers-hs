module Main (main) where
import Support.Runtime.StoragePublicContracts qualified as StoragePublicContracts
import Support.Runtime.ExportRequestCodec qualified as ExportRequestCodec
import Support.Runtime.ExportProducer qualified as ExportProducer
import Support.Runtime.QuickstartDatabase qualified as QuickstartDatabase
import Support.Runtime.GenerationAsync qualified as GenerationAsync
import Support.Runtime.EntrypointLifecycleErrors qualified as EntrypointLifecycleErrors
import Support.Runtime.RoutingCoverage qualified as RoutingCoverage
import Cloudflare.Workers.Streaming qualified as Streaming
import Support.Runtime.ClientRetryExtra qualified as ClientRetryExtra
import Support.Runtime.TransportExtra qualified as TransportExtra
import Support.Runtime.WorkflowBoundaryExtra qualified as WorkflowBoundaryExtra
import Support.Runtime.EntrypointErrors qualified as EntrypointErrors
import Support.Runtime.CacheServiceErrors qualified as CacheServiceErrors
import Support.Runtime.StorageObjectErrors qualified as StorageObjectErrors
import Support.Runtime.StorageErrors qualified as StorageErrors
import Cloudflare.Workers.Binding.D1
import Support.Runtime.Routing qualified as Routing
import Support.Runtime.AccessVerification qualified as AccessVerification
import Support.Runtime.AccessRoutes qualified as AccessRoutes
import Support.Runtime.BindingEnv qualified as BindingEnvProbe
import Support.Runtime.MiddlewareExtra qualified as MiddlewareExtra
import Support.Runtime.SQLBoundaries qualified as SQLBoundaries
import Support.Runtime.TypedQueueBoundaries qualified as TypedQueueBoundaries
import Support.Runtime.QuickstartBoundaries qualified as QuickstartBoundaries
import Support.Runtime.Client qualified as Client
import Envelope qualified
import Support.Runtime.SocketStream qualified as SocketStream
import Support.Runtime.StorageBoundaries qualified as StorageBoundaries
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import ExampleSupport.Interop (byteStringToJSByteArray, decodeEnveloped, jsByteArrayToByteString, jsValToText, textToJSVal)
import Cloudflare.Workers.Reactor (WorkersExecutionContext(..), passThroughOnException, waitUntil)
import Data.Text qualified as Text
import Control.Exception (throwIO, try, SomeException, displayException)
import Data.Aeson qualified as Aeson
import Data.Aeson.Types (parseEither, (.:), (.:?), (.!=))
import Data.ByteString (ByteString)
import Data.Text.Encoding qualified as TextEncoding
import Servant.Cloudflare.Workers.Access (AccessConfig (..), AccessClaims (..), AccessVerifierOptions(..), defaultAccessVerifierOptions, verifyAccessJWTWithOptions, verifyAccessServiceJWTWithOptions, AccessServiceClaims(..))
import Servant.Cloudflare.Workers.Access.SubtleCrypto (subtleImportKey, subtleVerify)
import GHC.Wasm.Prim (JSVal)
import Trace.Hpc.Reflect (examineTix)

main :: IO ()
main = pure ()

handler :: Request -> BindingEnv '[] '[] '[] -> WorkersExecutionContext -> IO Response
handler request _ _ = pure $ createResponse (Status 200) (headersFromList [("X-Method", methodToText (requestMethod request))]) $
  maybe (ResponseBodyBytes "") ResponseBodyStream (requestBody request)

jsFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
jsFetch = createFetchHandler handler
foreign export javascript "fetch" jsFetch :: JSVal -> JSVal -> JSVal -> IO JSVal

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
foreign export javascript "storage" storage :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

-- Exercise the production Haskell wrapper and FFI from the reactor, rather than
-- calling JavaScript crypto directly from the test harness.
cryptoVerify :: JSVal -> JSVal -> JSVal -> IO JSVal
cryptoVerify jwkValue signatureValue messageValue = do
  jwkJSON <- jsValToText jwkValue
  jwk <- either fail pure (Aeson.eitherDecodeStrict (TextEncoding.encodeUtf8 jwkJSON))
  key <- subtleImportKey "runtime-fixture" jwk
  signature <- jsByteArrayToByteString signatureValue
  message <- jsByteArrayToByteString messageValue
  result <- subtleVerify key signature message
  textToJSVal (if result then "valid" else "invalid")
foreign export javascript "cryptoVerify" cryptoVerify :: JSVal -> JSVal -> JSVal -> IO JSVal

jwtVerify :: JSVal -> IO JSVal
jwtVerify tokenValue = do
  token <- jsValToText tokenValue
  result <- verifyAccessJWTWithOptions
    defaultAccessVerifierOptions{accessVerifierOptionsJWKSCacheTtlSeconds = 0}
    (AccessConfig "runtime-audience" "runtime-team" "https://runtime-team.cloudflareaccess.com/cdn-cgi/access/certs")
    token
  textToJSVal (either (const "rejected") accessClaimsEmail result)
foreign export javascript "jwtVerify" jwtVerify :: JSVal -> IO JSVal

-- Test-only configuration: exercise real verifier policy and cache without
-- introducing short TTLs or alternate issuers into production bindings.
jwtVerifyConfigured :: JSVal -> IO JSVal
jwtVerifyConfigured inputValue = do
  input <- jsValToText inputValue
  value <- either fail pure (Aeson.eitherDecodeStrict (TextEncoding.encodeUtf8 input))
  (token, audience, team, url, skew, ttl, issuer) <- either fail pure $ parseEither
    (Aeson.withObject "Access verification fixture" $ \object ->
      (,,,,,,) <$> object .: "token" <*> object .: "audience" <*> object .: "team"
        <*> object .: "url" <*> object .: "skew" <*> object .: "ttl"
        <*> object .:? "issuer") value
  kind <- either fail pure $ parseEither (Aeson.withObject "Identity kind" (\o -> o .:? "identityKind" .!= ("user" :: Text.Text))) value
  if skew < 0 || ttl <= 0
    then textToJSVal "rejected"
    else case kind of
      "service" -> do
        result <- verifyAccessServiceJWTWithOptions (AccessVerifierOptions skew ttl issuer) (AccessConfig audience team url) token
        textToJSVal (either (const "rejected") accessServiceClaimsIdentifier result)
      "user" -> do
        result <- verifyAccessJWTWithOptions (AccessVerifierOptions skew ttl issuer) (AccessConfig audience team url) token
        textToJSVal (either (const "rejected") accessClaimsEmail result)
      _ -> textToJSVal "rejected"

foreign export javascript "jwtVerifyConfigured" jwtVerifyConfigured :: JSVal -> IO JSVal

-- A real D1 SELECT must yield the selected row, not run() metadata.
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
foreign export javascript "d1Lookup" d1Lookup :: JSVal -> JSVal -> IO JSVal

-- Development-only snapshot of this reactor; never exported by production.
coverage :: IO JSVal
coverage = examineTix >>= textToJSVal . Text.pack . show
foreign export javascript "coverage" coverage :: IO JSVal

-- Reflect Haskell exceptions explicitly at the fixture's JavaScript boundary.
observeContext :: IO () -> IO JSVal
observeContext action = do
  outcome <- try action
  textToJSVal $ either (Text.pack . displayException @SomeException) (const "ok") outcome

passThroughContext :: JSVal -> IO JSVal
passThroughContext = observeContext . passThroughOnException . WorkersExecutionContext
foreign export javascript "passThroughContext" passThroughContext :: JSVal -> IO JSVal

waitUntilContext :: JSVal -> JSVal -> IO JSVal
waitUntilContext context action = observeContext $ waitUntil (WorkersExecutionContext context) $ do
  result <- invokeContextAction action
  decodeEnveloped (const (pure ())) result >>= either (throwIO . userError . Text.unpack) pure
foreign export javascript "waitUntilContext" waitUntilContext :: JSVal -> JSVal -> IO JSVal
foreign import javascript safe "(async()=>{try{await $1();return {ok:true,value:null};}catch(error){return {ok:false,message:String(error)};}})()" invokeContextAction :: JSVal -> IO JSVal

envelopeProbe :: JSVal -> IO JSVal
envelopeProbe = Envelope.envelopeProbe
foreign export javascript "envelopeProbe" envelopeProbe :: JSVal -> IO JSVal

storageNativeProbe :: JSVal -> JSVal -> IO JSVal
storageNativeProbe = StorageBoundaries.storageNativeProbe
foreign export javascript "storageNativeProbe" storageNativeProbe :: JSVal -> JSVal -> IO JSVal

queueOutcome :: JSVal -> JSVal -> IO JSVal
queueOutcome = StorageBoundaries.queueOutcome
foreign export javascript "queueOutcome" queueOutcome :: JSVal -> JSVal -> IO JSVal

d1DecoderBoundaries :: IO JSVal
d1DecoderBoundaries = StorageBoundaries.d1DecoderBoundaries
foreign export javascript "d1DecoderBoundaries" d1DecoderBoundaries :: IO JSVal

socketProbe :: JSVal -> JSVal -> IO JSVal
socketProbe = SocketStream.socketProbe
foreign export javascript "socketProbe" socketProbe :: JSVal -> JSVal -> IO JSVal
routingProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
routingProbe modeValue requestValue contextValue = do
    mode <- jsValToText modeValue
    createFetchHandler (\request (_ :: BindingEnv '[] '[] '[]) context -> Routing.routingFixture mode request context) requestValue contextValue contextValue
foreign export javascript "routingProbe" routingProbe :: JSVal -> JSVal -> JSVal -> IO JSVal

clientServiceProbe :: JSVal -> JSVal -> IO JSVal
clientServiceProbe = Client.runClientService
foreign export javascript "clientServiceProbe" clientServiceProbe :: JSVal -> JSVal -> IO JSVal

bindingEnvProbe :: JSVal -> JSVal -> IO JSVal
bindingEnvProbe = BindingEnvProbe.bindingEnvProbe
foreign export javascript "bindingEnvProbe" bindingEnvProbe :: JSVal -> JSVal -> IO JSVal

quickstartManagementProbe :: JSVal -> Int -> JSVal -> JSVal -> IO JSVal
quickstartManagementProbe = QuickstartBoundaries.managementFetch
foreign export javascript "quickstartManagementProbe" quickstartManagementProbe :: JSVal -> Int -> JSVal -> JSVal -> IO JSVal

quickstartLeaseProbe :: JSVal -> Int -> IO JSVal
quickstartLeaseProbe = QuickstartBoundaries.leaseProbe
foreign export javascript "quickstartLeaseProbe" quickstartLeaseProbe :: JSVal -> Int -> IO JSVal

accessVerificationProbe :: JSVal -> JSVal -> IO JSVal
accessVerificationProbe = AccessVerification.accessVerificationProbe
foreign export javascript "accessVerificationProbe" accessVerificationProbe :: JSVal -> JSVal -> IO JSVal

accessRoutesProbe :: JSVal -> JSVal -> IO JSVal
accessRoutesProbe = AccessRoutes.accessRoutesProbe
foreign export javascript "accessRoutesProbe" accessRoutesProbe :: JSVal -> JSVal -> IO JSVal

middlewareExtraProbe :: JSVal -> JSVal -> IO JSVal
middlewareExtraProbe = MiddlewareExtra.middlewareExtraProbe
foreign export javascript "middlewareExtraProbe" middlewareExtraProbe :: JSVal -> JSVal -> IO JSVal

sqlProbe :: JSVal -> JSVal -> IO JSVal
sqlProbe = SQLBoundaries.sqlProbe
foreign export javascript "sqlProbe" sqlProbe :: JSVal -> JSVal -> IO JSVal

typedQueueProbe :: JSVal -> IO JSVal
typedQueueProbe = TypedQueueBoundaries.typedQueueProbe
foreign export javascript "typedQueueProbe" typedQueueProbe :: JSVal -> IO JSVal

storageErrorProbe :: JSVal -> JSVal -> IO JSVal
storageErrorProbe = StorageErrors.storageErrorProbe
foreign export javascript "storageErrorProbe" storageErrorProbe :: JSVal -> JSVal -> IO JSVal

storageObjectErrors :: JSVal -> JSVal -> IO JSVal
storageObjectErrors = StorageObjectErrors.storageObjectErrors
foreign export javascript "storageObjectErrors" storageObjectErrors :: JSVal -> JSVal -> IO JSVal

cacheServiceErrorsProbe :: JSVal -> JSVal -> IO JSVal
cacheServiceErrorsProbe = CacheServiceErrors.cacheServiceErrorsProbe
foreign export javascript "cacheServiceErrorsProbe" cacheServiceErrorsProbe :: JSVal -> JSVal -> IO JSVal

entrypointErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointErrorsProbe = EntrypointErrors.entrypointErrorsProbe
foreign export javascript "entrypointErrorsProbe" entrypointErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

workflowBoundaryExtraProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
workflowBoundaryExtraProbe = WorkflowBoundaryExtra.workflowBoundaryExtraProbe
foreign export javascript "workflowBoundaryExtraProbe" workflowBoundaryExtraProbe :: JSVal -> JSVal -> JSVal -> IO JSVal

transportExtraProbe :: JSVal -> JSVal -> IO JSVal
transportExtraProbe = TransportExtra.transportExtraProbe
foreign export javascript "transportExtraProbe" transportExtraProbe :: JSVal -> JSVal -> IO JSVal

clientRetryExtraProbe :: JSVal -> JSVal -> IO JSVal
clientRetryExtraProbe = ClientRetryExtra.runClientRetryExtra
foreign export javascript "clientRetryExtraProbe" clientRetryExtraProbe :: JSVal -> JSVal -> IO JSVal

routingCoverageProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
routingCoverageProbe modeValue requestValue contextValue _streamValue = do
    mode <- jsValToText modeValue
    source <- Streaming.readableStreamFromProducer $ \emit -> do
      _ <- emit (routingCoverageStreamBody mode)
      pure Streaming.StreamProducerCompleted
    createFetchHandler (\request (_ :: BindingEnv '[] '[] '[]) context -> RoutingCoverage.routingCoverageFixture mode request context source) requestValue contextValue contextValue
foreign export javascript "routingCoverageProbe" routingCoverageProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

routingCoverageStreamBody :: Text.Text -> ByteString
routingCoverageStreamBody mode = case mode of
  "custom-typeclass-stream" -> "custom-stream"
  "stream-context" -> "stream-body"
  "stream-headers" -> "download"
  _ -> ""

entrypointLifecycleErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointLifecycleErrorsProbe = EntrypointLifecycleErrors.entrypointLifecycleErrorsProbe
foreign export javascript "entrypointLifecycleErrorsProbe" entrypointLifecycleErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

quickstartDatabasePreparedProbe :: JSVal -> IO JSVal
quickstartDatabasePreparedProbe = QuickstartDatabase.preparedQueryProbe
foreign export javascript "quickstartDatabasePreparedProbe" quickstartDatabasePreparedProbe :: JSVal -> IO JSVal
generationAsyncProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
generationAsyncProbe = GenerationAsync.generationAsyncProbe
foreign export javascript "generationAsyncProbe" generationAsyncProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

exportRequestCodecProbe :: JSVal -> IO JSVal
exportRequestCodecProbe = ExportRequestCodec.exportRequestCodecProbe
foreign export javascript "exportRequestCodecProbe" exportRequestCodecProbe :: JSVal -> IO JSVal

storagePublicContractsProbe :: JSVal -> IO JSVal
storagePublicContractsProbe = StoragePublicContracts.storagePublicContractsProbe
foreign export javascript "storagePublicContractsProbe" storagePublicContractsProbe :: JSVal -> IO JSVal

exportProducerProbe :: JSVal -> IO JSVal
exportProducerProbe = ExportProducer.exportProducerProbe
foreign export javascript "exportProducerProbe" exportProducerProbe :: JSVal -> IO JSVal

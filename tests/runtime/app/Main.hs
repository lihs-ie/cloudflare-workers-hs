module Main (main) where

import Support.Runtime.PlatformChecks qualified as Platform
import Support.Runtime.CachePurge qualified as CachePurge
import Support.Runtime.WorkersAI qualified as WorkersAI
import Support.Runtime.Images qualified as Images
import Support.Runtime.Streaming qualified as Streaming
import Support.Runtime.JWKSCache qualified as JWKSCache
import Support.Runtime.D1QueryFixture qualified as D1Query
import Cloudflare.Workers.Binding.D1 (D1(..))
import Data.Aeson (encode)
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import WorkersSupport.Interop (textToJSVal)
import GHC.Wasm.Prim (JSVal)
import Support.Runtime.CoreEntrypoints qualified as Core
import Support.Runtime.AccessEntrypoints qualified as Access
import Support.Runtime.ServantEntrypoints qualified as Servant
import Support.Runtime.Client qualified as Client
import Support.Runtime.ClientRetryExtra qualified as ClientRetryExtra

main :: IO ()
main = pure ()

jsFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
jsFetch = Core.jsFetch
foreign export javascript "fetch" jsFetch :: JSVal -> JSVal -> JSVal -> IO JSVal

storage :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
storage = Core.storage
foreign export javascript "storage" storage :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

cryptoVerify :: JSVal -> JSVal -> JSVal -> IO JSVal
cryptoVerify = Access.cryptoVerify
foreign export javascript "cryptoVerify" cryptoVerify :: JSVal -> JSVal -> JSVal -> IO JSVal

jwtVerify :: JSVal -> IO JSVal
jwtVerify = Access.jwtVerify
foreign export javascript "jwtVerify" jwtVerify :: JSVal -> IO JSVal

jwtVerifyConfigured :: JSVal -> IO JSVal
jwtVerifyConfigured = Access.jwtVerifyConfigured
foreign export javascript "jwtVerifyConfigured" jwtVerifyConfigured :: JSVal -> IO JSVal

d1Lookup :: JSVal -> JSVal -> IO JSVal
d1Lookup = Core.d1Lookup
foreign export javascript "d1Lookup" d1Lookup :: JSVal -> JSVal -> IO JSVal

coverage :: IO JSVal
coverage = Core.coverage
foreign export javascript "coverage" coverage :: IO JSVal

passThroughContext :: JSVal -> IO JSVal
passThroughContext = Core.passThroughContext
foreign export javascript "passThroughContext" passThroughContext :: JSVal -> IO JSVal

waitUntilContext :: JSVal -> JSVal -> IO JSVal
waitUntilContext = Core.waitUntilContext
foreign export javascript "waitUntilContext" waitUntilContext :: JSVal -> JSVal -> IO JSVal

envelopeProbe :: JSVal -> IO JSVal
envelopeProbe = Core.envelopeProbe
foreign export javascript "envelopeProbe" envelopeProbe :: JSVal -> IO JSVal

storageNativeProbe :: JSVal -> JSVal -> IO JSVal
storageNativeProbe = Core.storageNativeProbe
foreign export javascript "storageNativeProbe" storageNativeProbe :: JSVal -> JSVal -> IO JSVal

queueOutcome :: JSVal -> JSVal -> IO JSVal
queueOutcome = Core.queueOutcome
foreign export javascript "queueOutcome" queueOutcome :: JSVal -> JSVal -> IO JSVal

d1DecoderBoundaries :: IO JSVal
d1DecoderBoundaries = Core.d1DecoderBoundaries
foreign export javascript "d1DecoderBoundaries" d1DecoderBoundaries :: IO JSVal

socketProbe :: JSVal -> JSVal -> IO JSVal
socketProbe = Core.socketProbe
foreign export javascript "socketProbe" socketProbe :: JSVal -> JSVal -> IO JSVal

routingProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
routingProbe = Servant.routingProbe
foreign export javascript "routingProbe" routingProbe :: JSVal -> JSVal -> JSVal -> IO JSVal

clientServiceProbe :: JSVal -> JSVal -> IO JSVal
clientServiceProbe = Client.runClientService
foreign export javascript "clientServiceProbe" clientServiceProbe :: JSVal -> JSVal -> IO JSVal

bindingEnvProbe :: JSVal -> JSVal -> IO JSVal
bindingEnvProbe = Core.bindingEnvProbe
foreign export javascript "bindingEnvProbe" bindingEnvProbe :: JSVal -> JSVal -> IO JSVal

accessVerificationProbe :: JSVal -> JSVal -> IO JSVal
accessVerificationProbe = Access.accessVerificationProbe
foreign export javascript "accessVerificationProbe" accessVerificationProbe :: JSVal -> JSVal -> IO JSVal

accessRoutesProbe :: JSVal -> JSVal -> IO JSVal
accessRoutesProbe = Access.accessRoutesProbe
foreign export javascript "accessRoutesProbe" accessRoutesProbe :: JSVal -> JSVal -> IO JSVal

middlewareExtraProbe :: JSVal -> JSVal -> IO JSVal
middlewareExtraProbe = Core.middlewareExtraProbe
foreign export javascript "middlewareExtraProbe" middlewareExtraProbe :: JSVal -> JSVal -> IO JSVal

sqlProbe :: JSVal -> JSVal -> IO JSVal
sqlProbe = Core.sqlProbe
foreign export javascript "sqlProbe" sqlProbe :: JSVal -> JSVal -> IO JSVal

typedQueueProbe :: JSVal -> IO JSVal
typedQueueProbe = Core.typedQueueProbe
foreign export javascript "typedQueueProbe" typedQueueProbe :: JSVal -> IO JSVal

storageErrorProbe :: JSVal -> JSVal -> IO JSVal
storageErrorProbe = Core.storageErrorProbe
foreign export javascript "storageErrorProbe" storageErrorProbe :: JSVal -> JSVal -> IO JSVal

storageObjectErrors :: JSVal -> JSVal -> IO JSVal
storageObjectErrors = Core.storageObjectErrors
foreign export javascript "storageObjectErrors" storageObjectErrors :: JSVal -> JSVal -> IO JSVal

cacheServiceErrorsProbe :: JSVal -> JSVal -> IO JSVal
cacheServiceErrorsProbe = Core.cacheServiceErrorsProbe
foreign export javascript "cacheServiceErrorsProbe" cacheServiceErrorsProbe :: JSVal -> JSVal -> IO JSVal

entrypointErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointErrorsProbe = Core.entrypointErrorsProbe
foreign export javascript "entrypointErrorsProbe" entrypointErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

workflowBoundaryExtraProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
workflowBoundaryExtraProbe = Core.workflowBoundaryExtraProbe
foreign export javascript "workflowBoundaryExtraProbe" workflowBoundaryExtraProbe :: JSVal -> JSVal -> JSVal -> IO JSVal

transportExtraProbe :: JSVal -> JSVal -> IO JSVal
transportExtraProbe = Core.transportExtraProbe
foreign export javascript "transportExtraProbe" transportExtraProbe :: JSVal -> JSVal -> IO JSVal

clientRetryExtraProbe :: JSVal -> JSVal -> IO JSVal
clientRetryExtraProbe = ClientRetryExtra.runClientRetryExtra
foreign export javascript "clientRetryExtraProbe" clientRetryExtraProbe :: JSVal -> JSVal -> IO JSVal

routingCoverageProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
routingCoverageProbe = Servant.routingCoverageProbe
foreign export javascript "routingCoverageProbe" routingCoverageProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

entrypointLifecycleErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointLifecycleErrorsProbe = Core.entrypointLifecycleErrorsProbe
foreign export javascript "entrypointLifecycleErrorsProbe" entrypointLifecycleErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

storagePublicContractsProbe :: JSVal -> IO JSVal
storagePublicContractsProbe = Core.storagePublicContractsProbe
foreign export javascript "storagePublicContractsProbe" storagePublicContractsProbe :: JSVal -> IO JSVal

sqlChecks :: JSVal -> IO JSVal
sqlChecks = Platform.sqlChecks
foreign export javascript "sqlChecks" sqlChecks :: JSVal -> IO JSVal

upgradeChecks :: IO JSVal
upgradeChecks = Platform.upgradeChecks
foreign export javascript "upgradeChecks" upgradeChecks :: IO JSVal

cachePurgeExample :: JSVal -> JSVal -> IO JSVal
cachePurgeExample = CachePurge.runCachePurge
foreign export javascript "cachePurgeExample" cachePurgeExample :: JSVal -> JSVal -> IO JSVal

workersAIProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
workersAIProbe = WorkersAI.probeWorkersAI
foreign export javascript "workersAIProbe" workersAIProbe :: JSVal -> JSVal -> JSVal -> IO JSVal

d1QueryFixture :: JSVal -> IO JSVal
d1QueryFixture database = textToJSVal . decodeUtf8 . Lazy.toStrict . encode =<< D1Query.runD1QueryFixture (D1 database)
foreign export javascript "d1QueryFixture" d1QueryFixture :: JSVal -> IO JSVal

imagesProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
imagesProbe = Images.probeImages
foreign export javascript "imagesProbe" imagesProbe :: JSVal -> JSVal -> JSVal -> IO JSVal

streamingProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
streamingProbe = Streaming.probeStreaming
foreign export javascript "streamingProbe" streamingProbe :: JSVal -> JSVal -> JSVal -> IO JSVal

jwksCacheScenarios :: IO JSVal
jwksCacheScenarios = textToJSVal . decodeUtf8 . Lazy.toStrict . encode =<< JWKSCache.runJWKSCacheScenarios
foreign export javascript "jwksCacheScenarios" jwksCacheScenarios :: IO JSVal

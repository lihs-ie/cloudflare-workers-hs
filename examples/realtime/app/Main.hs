{-# LANGUAGE CPP #-}
module Main (main) where
import Support.RoomFixture qualified as RoomFixture
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage)
#endif
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Entrypoint.DurableObject
import Cloudflare.Workers.Env (BindingEnv)
import Data.Aeson (encode, object, (.=))
import Cloudflare.Workers.HTTP (Response(..), Status(..))
import Cloudflare.Workers.Headers (headersFromList)
import ExampleSupport.Interop (jsValToText, responseToJSVal, textToJSVal)
import Control.Exception (SomeException, try, catch, throwIO)
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import Data.Proxy (Proxy(..))
import GHC.Wasm.Prim (JSVal)
import Realtime.API
import Realtime.Application qualified as Application
import Realtime.Room qualified as Room
import Support.SQLFixture qualified as SQLFixture
import Servant.Cloudflare.Workers.Server

main :: IO ()
main = pure ()
fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
fetch request env context = do
  rooms <- DurableObjectNamespace <$> jsRooms env
  createFetchHandler (\req (_ :: BindingEnv '[] '[] '[]) ctx -> serveWithContext (Proxy @API) EmptyContext (Application.server rooms) req ctx ()) request env context
#ifdef WASM_COVERAGE
coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_fetch argument0 argument1 argument2 = withCoverage (fetch argument0 argument1 argument2)
foreign export javascript "fetch" coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "fetch" fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#endif
foreign import javascript unsafe "$1.ROOMS" jsRooms :: JSVal -> IO JSVal
foreign import javascript unsafe "crypto.randomUUID()" jsUUID :: IO JSVal

roomFetch :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
roomFetch storage state request env context = do
  connectionIdentifier <- jsUUID >>= jsValToText
  createFetchHandler (\req (_ :: BindingEnv '[] '[] '[]) ctx -> serveWithContext (Proxy @RoomAPI) EmptyContext (Room.server (DurableObjectStorage storage) (WebSocketState state) connectionIdentifier) req ctx ()) request env context
#ifdef WASM_COVERAGE
coverage_roomFetch :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
coverage_roomFetch argument0 argument1 argument2 argument3 argument4 = withCoverage (roomFetch argument0 argument1 argument2 argument3 argument4)
foreign export javascript "roomFetch" coverage_roomFetch :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "roomFetch" roomFetch :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#endif

initializeRoom :: JSVal -> JSVal -> IO ()
initializeRoom storage state = Room.initialize (DurableObjectStorage storage) (WebSocketState state)
#ifdef WASM_COVERAGE
coverage_initializeRoom :: JSVal -> JSVal -> IO ()
coverage_initializeRoom argument0 argument1 = withCoverage (initializeRoom argument0 argument1)
foreign export javascript "initializeRoom" coverage_initializeRoom :: JSVal -> JSVal -> IO ()
#else
foreign export javascript "initializeRoom" initializeRoom :: JSVal -> JSVal -> IO ()
#endif

roomMessage :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
roomMessage storage state socket message env =
  createWebSocketMessageHandlerWithLimit 4096
    (\connection payload (_ :: BindingEnv '[] '[] '[]) -> Room.onMessage (DurableObjectStorage storage) (WebSocketState state) connection payload)
    socket message env `catch` \failure -> case failure of
      WebSocketMessageTooLarge _ -> webSocketClose (WebSocketConnection socket) 1009 "Message exceeds 4096 bytes"
      other -> throwIO other
#ifdef WASM_COVERAGE
coverage_roomMessage :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
coverage_roomMessage argument0 argument1 argument2 argument3 argument4 = withCoverage (roomMessage argument0 argument1 argument2 argument3 argument4)
foreign export javascript "roomMessage" coverage_roomMessage :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
#else
foreign export javascript "roomMessage" roomMessage :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
#endif

roomClose :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
roomClose storage = createWebSocketCloseHandler (\socket code reason clean (_ :: BindingEnv '[] '[] '[]) -> Room.onClose (DurableObjectStorage storage) socket code reason clean)
#ifdef WASM_COVERAGE
coverage_roomClose :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
coverage_roomClose argument0 argument1 argument2 argument3 argument4 argument5 = withCoverage (roomClose argument0 argument1 argument2 argument3 argument4 argument5)
foreign export javascript "roomClose" coverage_roomClose :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
#else
foreign export javascript "roomClose" roomClose :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> IO ()
#endif

sqlChecks :: JSVal -> IO JSVal
sqlChecks storage = textToJSVal . decodeUtf8 . Lazy.toStrict . encode =<< SQLFixture.sqlChecks (DurableObjectStorage storage)
#ifdef WASM_COVERAGE
coverage_sqlChecks :: JSVal -> IO JSVal
coverage_sqlChecks argument0 = withCoverage (sqlChecks argument0)
foreign export javascript "sqlChecks" coverage_sqlChecks :: JSVal -> IO JSVal
#else
foreign export javascript "sqlChecks" sqlChecks :: JSVal -> IO JSVal
#endif

upgradeChecks :: IO JSVal
upgradeChecks = do
  (client, _) <- webSocketPair
  response <- webSocketUpgradeResponse client
  accepted <- responseToJSVal response{responseHeaders = headersFromList [("x-upgrade", "retained")]}
  header <- jsHeader accepted >>= jsValToText
  rejected <- try @SomeException (responseToJSVal response{responseStatus = Status 403})
  invalidIdentifier <- try @DurableObjectError (doIDToString . DurableObjectID =<< jsInvalidIdentifier)
  throwingIdentifier <- try @DurableObjectError (doIDToString . DurableObjectID =<< jsThrowingIdentifier)
  let identifierRejected value = case value of Left (DurableObjectIDSerializationFailed _) -> True; _ -> False
      failed = case rejected of Left _ -> True; Right _ -> False
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode (object ["header" .= header, "statusMutationRejected" .= failed, "invalidIdentifierRejected" .= identifierRejected invalidIdentifier, "throwingIdentifierRejected" .= identifierRejected throwingIdentifier]))))
#ifdef WASM_COVERAGE
coverage_upgradeChecks :: IO JSVal
coverage_upgradeChecks  = withCoverage (upgradeChecks )
foreign export javascript "upgradeChecks" coverage_upgradeChecks :: IO JSVal
#else
foreign export javascript "upgradeChecks" upgradeChecks :: IO JSVal
#endif
foreign import javascript unsafe "$1.headers.get('x-upgrade')" jsHeader :: JSVal -> IO JSVal

foreign import javascript unsafe "({ toString() { return 42; } })" jsInvalidIdentifier :: IO JSVal
foreign import javascript unsafe "({ toString() { throw new Error('identifier fixture failure'); } })" jsThrowingIdentifier :: IO JSVal

roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
roomOversizeCheck storage state socket = RoomFixture.oversizedMessage (DurableObjectStorage storage) (WebSocketState state) (WebSocketConnection socket)
#ifdef WASM_COVERAGE
coverage_roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
coverage_roomOversizeCheck storage state socket = withCoverage (roomOversizeCheck storage state socket)
foreign export javascript "roomOversizeCheck" coverage_roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
#else
foreign export javascript "roomOversizeCheck" roomOversizeCheck :: JSVal -> JSVal -> JSVal -> IO ()
#endif

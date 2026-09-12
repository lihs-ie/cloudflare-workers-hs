module Support.Runtime.EntrypointLifecycleErrors (entrypointLifecycleErrorsProbe) where

import Cloudflare.Workers.Entrypoint.DurableObject
import Cloudflare.Workers.Entrypoint.Workflow
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Cloudflare.Workers.Binding.Var (Var, unVar)
import Data.Proxy (Proxy (..))
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Internal.FFI.Workflow (WorkflowNativeError (..))
import Control.Exception (AsyncException (ThreadKilled), SomeException, displayException, evaluate, throwIO, try)
import Data.Aeson
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)

type EmptyEnv = BindingEnv '[] '[] '[]
type ConfigEnv = BindingEnv '[] '[] '[ '("PREFIX", Var)]

entrypointLifecycleErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointLifecycleErrorsProbe rawMode native value env = do
    mode <- jsValToText rawMode
    outcome <- try @SomeException $ case mode of
        "message-env" -> unit (createWebSocketMessageHandler configuredMessage native value env)
        "close-env" -> do
            code <- closeCode value
            reason <- closeReason value
            clean <- closeClean value
            unit (createWebSocketCloseHandler configuredClose native code reason clean env)
        "workflow-timestamp" -> workflowResult (createWorkflowHandler timestampHandler value native env native)
        "workflow-decode" -> do
            raw <- stringify value >>= jsValToText
            event <- either fail pure (eitherDecodeStrict' @(WorkflowEvent Int) (Text.encodeUtf8 raw))
            pure (toJSON (workflowEventTimestamp event))
        "workflow-list" -> do
            raw <- stringify value >>= jsValToText
            events <- either fail pure (eitherDecodeStrict' @[WorkflowEvent Int] (Text.encodeUtf8 raw))
            pure (toJSON (map (\event -> (workflowEventPayload event, workflowEventTimestamp event)) events))
        "connections" -> toJSON . length <$> webSocketConnections (WebSocketState native) Nothing
        "attachment" -> toJSON <$> webSocketGetAttachment @Int (WebSocketConnection native)
        "send" -> unit (webSocketSend (WebSocketConnection native) (WebSocketTextMessage "message"))
        "binary-send" -> unit (webSocketSend (WebSocketConnection native) (WebSocketBinaryMessage (Bytes.pack [0, 255])))
        "accept" -> unit (webSocketAcceptHibernating (WebSocketState native) (WebSocketConnection value) ["test"])
        "set-attachment" -> unit (webSocketSetAttachment (WebSocketConnection native) (7 :: Int))
        "close" -> unit (webSocketClose (WebSocketConnection native) 1000 "finished")
        "auto-response" -> unit (webSocketSetAutoResponse (WebSocketState native) Nothing)
        "negative-limit" -> unit (createWebSocketMessageHandlerWithLimit (-1) messageHandler native value env)
        "limit" -> unit (createWebSocketMessageHandlerWithLimit 3 messageHandler native value env)
        "close-handler-failure" -> do
            code <- closeCode value
            reason <- closeReason value
            clean <- closeClean value
            unit (createWebSocketCloseHandler closeHandler native code reason clean env)
        "handler-failure" -> unit (createWebSocketMessageHandler messageHandler native value env)
        "native-error-diagnostics" -> do
            let errors = [WorkflowNativeError "first" native, WorkflowNativeError "second" native]
            pure $ object ["list" .= showList errors " suffix", "individual" .= map (\failure -> showsPrec 0 failure " suffix") errors]
        "native-error-show" -> pure (toJSON (show (WorkflowNativeError "native failure" native)))
        "workflow-invalid" -> workflowResult (createWorkflowHandler normalHandler value native env native)
        "workflow-unsafe-number" -> workflowResult (createWorkflowHandler unsafeNumberHandler value native env native)
        "workflow-async" -> do
            _ <- createWorkflowHandler asyncHandler value native env native
            fail "asynchronous exception was swallowed"
        _ -> fail "Unknown entrypoint lifecycle mode"
    textToJSVal $ Text.decodeUtf8 $ Lazy.toStrict $ encode $
        either (\exception -> object ["ok" .= False, "message" .= displayException exception])
               (\result -> object ["ok" .= True, "value" .= result]) outcome
  where
    configuredMessage :: WebSocketMessageHandler ConfigEnv
    configuredMessage socket payload bindings = case payload of
        WebSocketTextMessage text -> webSocketSend socket (WebSocketTextMessage (unVar (getBinding (Proxy @"PREFIX") bindings) <> text))
        WebSocketBinaryMessage bytes -> webSocketSend socket (WebSocketBinaryMessage bytes)
    configuredClose :: WebSocketCloseHandler ConfigEnv
    configuredClose socket code reason clean bindings =
        webSocketSetAttachment socket (object ["prefix" .= unVar (getBinding (Proxy @"PREFIX") bindings), "code" .= code, "reason" .= reason, "clean" .= clean])
    timestampHandler :: WorkflowHandler Value EmptyEnv Value
    timestampHandler event _ _ = pure (object ["timestamp" .= workflowEventTimestamp event, "payload" .= workflowEventPayload event])
    unit action = action >> pure (Bool True)
    messageHandler :: WebSocketMessageHandler EmptyEnv
    messageHandler _ payload _ = evaluate payload >> fail "message handler failed"
    asyncHandler :: WorkflowHandler Value EmptyEnv Value
    asyncHandler _ _ _ = throwIO ThreadKilled

    closeHandler :: WebSocketCloseHandler EmptyEnv
    closeHandler _ code reason clean _ =
        evaluate (length (show (code, reason, clean))) >> fail "close handler failed"
    normalHandler :: WorkflowHandler Int EmptyEnv Value
    normalHandler event _ _ = pure (toJSON (workflowEventPayload event))
    unsafeNumberHandler :: WorkflowHandler Value EmptyEnv Value
    unsafeNumberHandler _ _ _ = pure (toJSON (9007199254740992 :: Integer))
    workflowResult action = do
        raw <- action >>= stringify >>= jsValToText
        either fail pure (eitherDecodeStrict' (Text.encodeUtf8 raw))

foreign import javascript unsafe "JSON.stringify($1)" stringify :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.code" closeCode :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.reason" closeReason :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.clean" closeClean :: JSVal -> IO JSVal

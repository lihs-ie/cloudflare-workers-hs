module Support.Runtime.BindingEnv (bindingEnvProbe) where

import Cloudflare.Workers.Binding.Assets (Assets)
import Cloudflare.Workers.Binding.Custom (CustomBinding, withCustomBinding)
import Cloudflare.Workers.Binding.D1 (D1)
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace, DurableObjectStorage, DurableObjectValue(..), doGetByName, doCall)
import Cloudflare.Workers.Binding.KV (KV, KVValue (KVTextValue), KVReadType (KVReadText), kvGet, kvReadDefaultOptions)
import Cloudflare.Workers.Binding.Queue (QueueProducer)
import Cloudflare.Workers.Binding.R2 (R2Bucket)
import Cloudflare.Workers.Binding.Secret (Secret, revealSecret)
import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding, serviceCall)
import Cloudflare.Workers.Binding.Workflow (Workflow)
import Cloudflare.Workers.Binding.Var (Var, unVar)
import Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal)
import Cloudflare.Workers.Env (BindingEnv (BindingEnv), BindingMissingError (BindingMissingError), getBinding, getDurableObjectNamespace)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, try, evaluate)
import Data.Dynamic (toDyn)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString.Lazy qualified as LazyBytes
import Data.Map.Strict qualified as Map
import Data.Proxy (Proxy (Proxy))
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Encoding
import GHC.Wasm.Prim (JSVal)

data CustomProbe

type Configuration =
    '[ '("REQUIRED_VAR", Var), '("REQUIRED_SECRET", Secret)
     , '("OPTIONAL_VAR", Maybe Var), '("OPTIONAL_SECRET", Maybe Secret)
     ]

type NativeBindings =
    '[ '("ASSETS", Assets), '("DB", D1), '("ROOMS", DurableObjectNamespace)
     , '("STORAGE", DurableObjectStorage), '("KV", KV), '("QUEUE", QueueProducer)
     , '("BUCKET", R2Bucket), '("SERVICE", ServiceBinding), '("WORKFLOW", Workflow Value)
     ]

-- Configuration failures become data at the fixture boundary; a following
-- call must remain usable, and secret values never appear in diagnostics.
bindingEnvProbe :: JSVal -> JSVal -> IO JSVal
bindingEnvProbe raw modeValue = do
    mode <- jsValToText modeValue
    result <- try @SomeException $ case mode of
        "typed-missing" -> do
            loaded <- try @BindingMissingError $
                bindingEnvFromJSVal @'[] @'[] @'[ '("REQUIRED_VAR", Var)] raw
            case loaded of
                Left failure@(BindingMissingError name) ->
                    pure (object ["missing" .= name, "recoverable" .= (failure == BindingMissingError "REQUIRED_VAR")])
                Right env -> pure (object ["value" .= unVar (getBinding (Proxy @"REQUIRED_VAR") env)])
        "native-consumer" -> do
            env <- bindingEnvFromJSVal @'[] @'[] @'[ '("KV", KV), '("SERVICE", ServiceBinding)] raw
            fetched <- kvGet (getBinding (Proxy @"KV") env) "configuration-key" KVReadText kvReadDefaultOptions
            value <- case fetched of
                Just (KVTextValue text) -> pure text
                _ -> fail "Expected text configuration value"
            argument <- textToJSVal value
            called <- serviceCall (getBinding (Proxy @"SERVICE") env) "decorate" [DurableObjectValue argument]
            case called of
                Left failure -> fail (show failure)
                Right (DurableObjectValue result) -> do
                    decorated <- jsValToText result
                    pure (object ["configuration" .= value, "decorated" .= decorated])
        "configuration" -> do
            env <- bindingEnvFromJSVal @'[] @'[] @Configuration raw
            pure $ object
                [ "requiredVar" .= unVar (getBinding (Proxy @"REQUIRED_VAR") env)
                , "requiredSecretLength" .= Text.length (revealSecret (getBinding (Proxy @"REQUIRED_SECRET") env))
                , "optionalVar" .= fmap unVar (getBinding (Proxy @"OPTIONAL_VAR") env)
                , "optionalSecretLength" .= fmap (Text.length . revealSecret) (getBinding (Proxy @"OPTIONAL_SECRET") env)
                ]
        "custom" -> do
            env <-
                bindingEnvFromJSVal
                    @'[]
                    @'[]
                    @'[ '("CUSTOM", CustomBinding CustomProbe)
                      , '("OPTIONAL_CUSTOM", Maybe (CustomBinding CustomProbe))
                      ]
                    raw
            requiredValue <-
                withCustomBinding
                    (getBinding (Proxy @"CUSTOM") env)
                    (`invokeCustomBinding` "required")
            optionalValue <-
                traverse
                    (\binding ->
                        withCustomBinding
                            binding
                            (`invokeCustomBinding` "optional")
                    )
                    (getBinding (Proxy @"OPTIONAL_CUSTOM") env)
            pure $
                object
                    [ "required" .= requiredValue
                    , "optional" .= optionalValue
                    ]
        "missing-map" -> do
            let env = BindingEnv Map.empty Map.empty :: BindingEnv '[] '[] '[ '("VALUE", Var)]
            value <- evaluate (unVar (getBinding (Proxy @"VALUE") env))
            pure (object ["value" .= value])
        "wrong-type" -> do
            let env = BindingEnv (Map.singleton "VALUE" (toDyn (7 :: Int))) Map.empty :: BindingEnv '[] '[] '[ '("VALUE", Var)]
            value <- evaluate (unVar (getBinding (Proxy @"VALUE") env))
            pure (object ["value" .= value])
        "missing-namespace" -> do
            let env = BindingEnv Map.empty Map.empty :: BindingEnv '[] '["ROOMS"] '[]
            _ <- evaluate (getDurableObjectNamespace (Proxy @"ROOMS") env)
            pure (object ["unexpected" .= True])
        "namespace-rpc" -> do
            env <- bindingEnvFromJSVal @'[] @'["ROOMS"] @'[] raw
            stub <- doGetByName (getDurableObjectNamespace (Proxy @"ROOMS") env) "env-proof"
            command <- textToJSVal "get"
            key <- textToJSVal "env-proof-key"
            bytes <- emptyArray
            result <- doCall stub "operation" (map DurableObjectValue [command,key,bytes])
            case result of
                Left failure -> fail (show failure)
                Right (DurableObjectValue value) -> do
                    encoded <- stringify value >>= jsValToText
                    pure (object ["persisted" .= encoded])
        "namespace" -> do
            env@(BindingEnv _ namespaces) <- bindingEnvFromJSVal @'[] @'["ROOMS"] @'[] raw
            _ <- evaluate (getDurableObjectNamespace (Proxy @"ROOMS") env)
            pure (object ["names" .= Map.keys namespaces])
        "empty" -> do
            BindingEnv bindings namespaces <- bindingEnvFromJSVal @'[] @'[] @'[] raw
            pure (object ["bindings" .= Map.size bindings, "namespaces" .= Map.size namespaces])
        "native" -> do
            BindingEnv bindings _ <- bindingEnvFromJSVal @'[] @'[] @NativeBindings raw
            pure (object ["names" .= Map.keys bindings])
        _ -> fail "Unknown binding environment scenario"
    let response :: Value
        response = either (\err -> object ["ok" .= False, "message" .= displayException err])
            (\value -> object ["ok" .= True, "value" .= value]) result
    textToJSVal (Encoding.decodeUtf8 (LazyBytes.toStrict (encode response)))

foreign import javascript unsafe "[]" emptyArray :: IO JSVal
foreign import javascript safe "JSON.stringify($1)" stringify :: JSVal -> IO JSVal

invokeCustomBinding :: JSVal -> Text.Text -> IO Text.Text
invokeCustomBinding binding input = do
    inputJSVal <- textToJSVal input
    jsInvokeCustomBinding binding inputJSVal >>= jsValToText

foreign import javascript safe "$1.sign($2)"
    jsInvokeCustomBinding :: JSVal -> JSVal -> IO JSVal

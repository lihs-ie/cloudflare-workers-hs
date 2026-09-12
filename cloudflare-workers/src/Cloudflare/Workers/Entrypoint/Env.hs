module Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal) where

import Cloudflare.Workers.Env (BindingEnv (BindingEnv))
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv (buildBindingEnv), BuildDOSEnv (buildDOSEnv))
import Cloudflare.Workers.Internal.FFI.Env (envFromJSVal)
import Data.Proxy (Proxy (Proxy))
import GHC.Wasm.Prim (JSVal)

bindingEnvFromJSVal ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    JSVal ->
    IO (BindingEnv kvs dos bindings)
bindingEnvFromJSVal envJSVal = do
    rawBindings <- envFromJSVal envJSVal
    typedBindings <- buildBindingEnv (Proxy @bindings) rawBindings
    typedDos <- buildDOSEnv (Proxy @dos) rawBindings
    pure (BindingEnv typedBindings typedDos)

{-# LANGUAGE CPP #-}
module Main (main) where
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage)
#endif

import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import GHC.Wasm.Prim (JSVal)
import Minimal.Application (server)
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Generic (genericServeWithContext)
import Servant.Cloudflare.Workers.Server.Internal ()

main :: IO ()
main = pure ()

fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
fetch = createFetchHandler $ \request (_ :: BindingEnv '[] '[] '[]) context ->
    genericServeWithContext EmptyContext server request context ()

#ifdef WASM_COVERAGE
coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_fetch argument0 argument1 argument2 = withCoverage (fetch argument0 argument1 argument2)
foreign export javascript "fetch" coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "fetch" fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#endif

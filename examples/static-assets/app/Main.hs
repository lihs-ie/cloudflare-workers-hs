{-# LANGUAGE CPP #-}
module Main (main) where
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage)
#endif

import Cloudflare.Workers.Binding.Assets (Assets)
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Data.Proxy (Proxy(..))
import GHC.Wasm.Prim (JSVal)
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Assets (serveWithAssets)
import StaticAssets.API (API)
import StaticAssets.Application (server)

main :: IO ()
main = pure ()

fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
fetch = createFetchHandler $ \request (bindings :: BindingEnv '[] '[] '[ '("ASSETS", Assets)]) context ->
    serveWithAssets [["api"]] (getBinding (Proxy @"ASSETS") bindings) (Proxy @API) EmptyContext server request context ()
#ifdef WASM_COVERAGE
coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_fetch argument0 argument1 argument2 = withCoverage (fetch argument0 argument1 argument2)
foreign export javascript "fetch" coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "fetch" fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#endif

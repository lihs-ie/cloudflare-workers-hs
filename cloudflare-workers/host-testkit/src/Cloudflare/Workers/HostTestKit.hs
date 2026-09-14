module Cloudflare.Workers.HostTestKit (
    phantomJSVal,
) where

import GHC.Wasm.Prim (JSVal, hostPhantomJSVal)

phantomJSVal :: JSVal
phantomJSVal = hostPhantomJSVal

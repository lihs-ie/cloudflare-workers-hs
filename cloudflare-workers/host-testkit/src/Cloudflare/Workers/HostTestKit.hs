module Cloudflare.Workers.HostTestKit (
    phantomJSVal,
) where

import GHC.Wasm.Prim.Host.Internal (JSVal (HostPhantomJSVal))

phantomJSVal :: JSVal
phantomJSVal = HostPhantomJSVal

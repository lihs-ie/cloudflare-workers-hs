module GHC.Wasm.Prim (JSVal, hostPhantomJSVal) where

data JSVal = HostPhantomJSVal

hostPhantomJSVal :: JSVal
hostPhantomJSVal = HostPhantomJSVal

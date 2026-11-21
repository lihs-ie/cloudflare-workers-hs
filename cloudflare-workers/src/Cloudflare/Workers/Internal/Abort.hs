module Cloudflare.Workers.Internal.Abort (AbortSignal (..)) where

import GHC.Wasm.Prim (JSVal)

newtype AbortSignal = AbortSignal JSVal

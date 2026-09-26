module Cloudflare.Workers.Internal.Abort (AbortController (..), AbortSignal (..)) where

import GHC.Wasm.Prim (JSVal)

newtype AbortController = AbortController JSVal

newtype AbortSignal = AbortSignal JSVal

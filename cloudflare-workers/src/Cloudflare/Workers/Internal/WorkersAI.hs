module Cloudflare.Workers.Internal.WorkersAI (WorkersAI (..)) where

import GHC.Wasm.Prim (JSVal)

newtype WorkersAI = WorkersAI JSVal

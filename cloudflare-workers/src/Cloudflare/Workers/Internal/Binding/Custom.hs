module Cloudflare.Workers.Internal.Binding.Custom (
    CustomBinding (CustomBinding),
    withCustomBinding,
) where

import Data.Kind (Type)
import GHC.Wasm.Prim (JSVal)

-- Keep distinct application-defined binding capabilities nominally separate.
type role CustomBinding nominal

-- | An opaque JavaScript Worker binding tagged by an application capability.
newtype CustomBinding (tag :: Type) = CustomBinding JSVal

{- | Run an infrastructure callback with the underlying JavaScript binding.

Keeping the constructor private prevents application code from fabricating
or retagging a custom binding. The callback should immediately call the
capability's JSFFI adapter instead of returning the 'JSVal'.
-}
withCustomBinding :: CustomBinding tag -> (JSVal -> IO result) -> IO result
withCustomBinding (CustomBinding binding) action = action binding

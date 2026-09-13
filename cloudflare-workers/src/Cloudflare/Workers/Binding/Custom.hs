{- | Typed access to application-defined JavaScript bindings.

Use a distinct, uninhabited marker type for each JavaScript capability. The
marker has a nominal role, so bindings for different capabilities cannot be
coerced into one another. The constructor is intentionally hidden: values
are created only while decoding a 'Cloudflare.Workers.Env.BindingEnv'.

'withCustomBinding' exposes the opaque JavaScript value only to a scoped
infrastructure callback. Domain, use-case, and presentation code can keep
using the typed wrapper without importing an internal binding module.
Decoding checks that the value is a JavaScript object or function; the marker
type and infrastructure adapter define its application-specific shape.
-}
module Cloudflare.Workers.Binding.Custom (
    CustomBinding,
    withCustomBinding,
) where

import Cloudflare.Workers.Internal.Binding.Custom (
    CustomBinding,
    withCustomBinding,
 )

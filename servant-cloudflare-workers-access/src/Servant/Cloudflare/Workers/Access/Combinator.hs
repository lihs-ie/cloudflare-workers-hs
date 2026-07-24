{-# OPTIONS_GHC -Wno-orphans #-}

module Servant.Cloudflare.Workers.Access.Combinator (
    ZeroTrust,
) where

import Servant.API ((:>))

import Servant.Cloudflare.Workers.Access (AccessClaims)
import Servant.Cloudflare.Workers.Server (HasWorkerServer (ServerT, serveWithContext))

{- | Empty marker type: ZeroTrust :> api requires a verified Cloudflare
Access identity before dispatching into api. Never constructed --
ZeroTrust only ever appears as a type, the same way servant's own
combinators (Capture, ReqBody, ...) are type-level markers.
-}
data ZeroTrust

instance (HasWorkerServer api) => HasWorkerServer (ZeroTrust :> api) where
    type ServerT (ZeroTrust :> api) m = AccessClaims -> ServerT api m
    serveWithContext = error "unimplemented"

{- | Public building blocks for defining custom 'HasWorkerServer' combinators.

The routing and delayed-check types are intentionally abstract. Extensions
can add authentication checks and delegate to the next API with @route@, but
cannot construct or inspect the internal route tree.
-}
module Servant.Cloudflare.Workers.Server.Extension (
    Delayed,
    DelayedIO,
    Router,
    addAuthCheck,
    withRequest,
    delayedFail,
    delayedFailFatal,
) where

import Servant.Cloudflare.Workers.Server.Internal.Delayed (Delayed, addAuthCheck)
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (DelayedIO, delayedFail, delayedFailFatal, withRequest)
import Servant.Cloudflare.Workers.Server.Internal.Router (Router)

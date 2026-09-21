{- |
Public entry points for the Workers-native Servant interpreter.

The 'respond' helper is adapted from @servant-server-0.20.3.0@
@Servant.Server.UVerb@: Copyright (c) 2014-2016, Zalora South East Asia Pte Ltd,
2016-2018 Servant Contributors, distributed under BSD-3-Clause. The remainder
of this facade delegates to the independently implemented Workers router.
-}
module Servant.Cloudflare.Workers.Server (
    HasWorkerServer (..),
    Server,
    Context (..),
    HasContextEntry (..),
    NamedContext (..),
    EmptyServer (..),
    descendIntoNamedContext,
    serveWithContext,
    runHandlerAction,
    respond,
) where

import Cloudflare.Workers.HTTP (Request, Response, requestURL)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Cloudflare.Workers.URL (urlPathRaw)
import Data.Proxy (Proxy)
import Data.SOP.BasicFunctors (I (I))
import Servant.API.UVerb (HasStatus, IsMember, Union, inject)
import Servant.Cloudflare.Workers.Error (serverErrorToResponse)
import Servant.Cloudflare.Workers.Server.Internal (EmptyServer (..), runHandlerAction)
import Servant.Cloudflare.Workers.Server.Internal.Context
import Servant.Cloudflare.Workers.Server.Internal.Delayed (emptyDelayed)
import Servant.Cloudflare.Workers.Server.Internal.HasWorkerServer
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (RouteResult (Fail, FailFatal, Route))
import Servant.Cloudflare.Workers.Server.Internal.Router (runRouterEnv, splitPathSegments)

serveWithContext ::
    forall api context env.
    (HasWorkerServer api context) =>
    Proxy api ->
    Context context ->
    Server api env ->
    Request ->
    WorkersExecutionContext ->
    env ->
    IO Response
serveWithContext apiProxy context server request cloudflareContext bindingEnv = do
    routed <-
        runRouterEnv
            (route @api @context @_ @env apiProxy context (emptyDelayed (Route server)))
            ()
            (splitPathSegments (urlPathRaw (requestURL request)))
            request
            cloudflareContext
            bindingEnv
    pure $ case routed of
        Route response -> response
        Fail err -> serverErrorToResponse request err
        FailFatal err -> serverErrorToResponse request err

-- | Inject a declared response into a typed 'Union'.
respond :: (Applicative m, HasStatus a, IsMember a as) => a -> m (Union as)
respond = pure . inject . I

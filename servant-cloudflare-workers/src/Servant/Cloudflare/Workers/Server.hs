{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}

module Servant.Cloudflare.Workers.Server (
    HasWorkerServer (..),
    Server,
    Context (..),
    HasContextEntry (..),
    NamedContext (..),
    descendIntoNamedContext,
    serveWithContext,
    runHandlerAction,
) where

import Cloudflare.Workers.HTTP (Request, Response, requestURL)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Cloudflare.Workers.URL (urlPathRaw)
import Control.Monad.Except (runExceptT)
import Control.Monad.Reader (ReaderT (runReaderT))
import Data.Data (Proxy (Proxy))
import Data.Kind (Type)
import GHC.TypeLits (Symbol)
import Servant.Cloudflare.Workers.Error (serverErrorToResponse)
import Servant.Cloudflare.Workers.Handler (Handler (unHandler))
import Servant.Cloudflare.Workers.Server.Internal.Delayed (Delayed, emptyDelayed, runDelayed)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (RouteResult (Fail, FailFatal, Route))
import Servant.Cloudflare.Workers.Server.Internal.Router (Router, runRouterEnv, splitPathSegments)

data Context (context :: [Type]) where
    EmptyContext :: Context '[]
    (:.) :: x -> Context xs -> Context (x ': xs)

infixr 5 :.

class HasContextEntry (context :: [Type]) (value :: Type) where
    getContextEntry :: Context context -> value

instance
    {-# OVERLAPPABLE #-}
    (HasContextEntry xs val) =>
    HasContextEntry (notIt ': xs) val
    where
    getContextEntry (_ :. xs) = getContextEntry xs

instance {-# OVERLAPPING #-} HasContextEntry (val ': xs) val where
    getContextEntry (x :. _) = x

class HasWorkerServer api context where
    type ServerT api (m :: Type -> Type) :: Type

    route ::
        Proxy api ->
        Context context ->
        Delayed capEnv (ServerT api (Handler bindingEnv)) ->
        Router capEnv bindingEnv

type Server api env = ServerT api (Handler env)

newtype NamedContext (name :: Symbol) (subContext :: [Type]) = NamedContext (Context subContext)

descendIntoNamedContext ::
    forall context name subContext.
    (HasContextEntry context (NamedContext name subContext)) =>
    Proxy (name :: Symbol) ->
    Context context ->
    Context subContext
descendIntoNamedContext Proxy context =
    let NamedContext subContext = getContextEntry context :: NamedContext name subContext
     in subContext

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

runHandlerAction ::
    WorkersExecutionContext ->
    bindingEnv ->
    Delayed captureEnv (Handler bindingEnv a) ->
    captureEnv ->
    Request ->
    (a -> IO (RouteResult Response)) ->
    IO (RouteResult Response)
runHandlerAction cloudflareContext bindingEnv delayed captureEnv request toResponse = do
    delayedResult <- runDelayed delayed captureEnv request
    case delayedResult of
        Fail err -> pure (Fail err)
        FailFatal err -> pure (FailFatal err)
        Route handlerAction -> do
            handlerResult <- runExceptT (runReaderT (runReaderT (unHandler handlerAction) bindingEnv) cloudflareContext)
            case handlerResult of
                Left err -> pure (Route (serverErrorToResponse request err))
                Right value -> toResponse value

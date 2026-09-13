module Servant.Cloudflare.Workers.Server.Internal.RouteResult (
    RouteResult (..),
    RouteResultT (..),
) where

import Control.Monad (ap)
import Control.Monad.IO.Class (MonadIO (liftIO))
import Control.Monad.Trans.Class (MonadTrans (lift))
import Servant.Cloudflare.Workers.Error (ServerError)

data RouteResult a
    = Fail ServerError
    | FailFatal ServerError
    | Route a
    deriving stock (Eq, Show, Functor)

instance Monad RouteResult where
    Route a >>= f = f a
    Fail e >>= _ = Fail e
    FailFatal e >>= _ = FailFatal e

instance Applicative RouteResult where
    pure = Route
    (<*>) = ap

newtype RouteResultT m a = RouteResultT {runRouteResultT :: m (RouteResult a)}
    deriving stock (Functor)

instance MonadTrans RouteResultT where
    lift = RouteResultT . fmap Route

instance (Functor m, Monad m) => Applicative (RouteResultT m) where
    pure = RouteResultT . pure . Route
    (<*>) = ap

instance (Monad m) => Monad (RouteResultT m) where
    m >>= k = RouteResultT $ do
        a <- runRouteResultT m
        case a of
            Fail e -> pure (Fail e)
            FailFatal e -> pure (FailFatal e)
            Route b -> runRouteResultT (k b)

instance (MonadIO m) => MonadIO (RouteResultT m) where
    liftIO = lift . liftIO

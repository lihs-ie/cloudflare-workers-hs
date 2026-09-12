module Servant.Cloudflare.Workers.Server.Internal.DelayedIO (
    DelayedIO,
    delayedFail,
    delayedFailFatal,
    liftRouteResult,
    runDelayedIO,
    withRequest,
) where

import Control.Monad.IO.Class (MonadIO)
import Control.Monad.Reader (MonadReader, ReaderT (ReaderT), ask, runReaderT)

import Cloudflare.Workers.HTTP (Request)
import Servant.Cloudflare.Workers.Error (ServerError)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (
    RouteResult (Fail, FailFatal),
    RouteResultT (RouteResultT, runRouteResultT),
 )

newtype DelayedIO a = DelayedIO (ReaderT Request (RouteResultT IO) a)
    deriving newtype (Functor, Applicative, Monad, MonadIO, MonadReader Request)

liftRouteResult :: RouteResult a -> DelayedIO a
liftRouteResult result = DelayedIO (ReaderT (const (RouteResultT (pure result))))

delayedFail :: ServerError -> DelayedIO a
delayedFail serverError = liftRouteResult (Fail serverError)

delayedFailFatal :: ServerError -> DelayedIO a
delayedFailFatal serverError = liftRouteResult (FailFatal serverError)

withRequest :: (Request -> DelayedIO a) -> DelayedIO a
withRequest f = ask >>= f

runDelayedIO :: DelayedIO a -> Request -> IO (RouteResult a)
runDelayedIO (DelayedIO reader) request = runRouteResultT (runReaderT reader request)

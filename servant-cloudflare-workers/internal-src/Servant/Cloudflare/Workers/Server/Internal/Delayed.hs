{-# LANGUAGE RecordWildCards #-}

module Servant.Cloudflare.Workers.Server.Internal.Delayed (
    Delayed (..),
    addAcceptCheck,
    addAuthCheck,
    addBodyCheck,
    addCapture,
    addHeaderCheck,
    addMethodCheck,
    addParameterCheck,
    emptyDelayed,
    passToServer,
    runDelayed,
) where

import Cloudflare.Workers.HTTP (Request)
import Control.Monad.Reader (ask)
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (DelayedIO, liftRouteResult, runDelayedIO)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (RouteResult)

data Delayed captureEnv c where
    Delayed ::
        { capturesD :: captureEnv -> DelayedIO captures
        , methodD :: DelayedIO ()
        , authD :: DelayedIO auth
        , acceptD :: DelayedIO ()
        , contentD :: DelayedIO contentType
        , paramsD :: DelayedIO params
        , headersD :: DelayedIO headers
        , bodyD :: contentType -> DelayedIO body
        , serverD ::
            captures ->
            params ->
            headers ->
            auth ->
            body ->
            Request ->
            RouteResult c
        } ->
        Delayed captureEnv c

instance Functor (Delayed captureEnv) where
    fmap f Delayed{..} =
        Delayed
            { serverD = \captures params headers auth body request -> f <$> serverD captures params headers auth body request
            , ..
            }

emptyDelayed :: RouteResult a -> Delayed captureEnv a
emptyDelayed result =
    Delayed (const noop) noop noop noop noop noop noop (const noop) (\_ _ _ _ _ _ -> result)
  where
    noop = pure ()

addCapture ::
    Delayed captureEnv (a -> b) ->
    (captured -> DelayedIO a) ->
    Delayed (captured, captureEnv) b
addCapture Delayed{..} new =
    Delayed
        { capturesD = \(captured, captureEnv) -> (,) <$> capturesD captureEnv <*> new captured
        , serverD = \(capturesValue, newValue) params headers auth body request ->
            ($ newValue) <$> serverD capturesValue params headers auth body request
        , ..
        }

addMethodCheck :: Delayed captureEnv a -> DelayedIO () -> Delayed captureEnv a
addMethodCheck Delayed{..} new =
    Delayed{methodD = methodD <* new, ..}

addAcceptCheck :: Delayed captureEnv a -> DelayedIO () -> Delayed captureEnv a
addAcceptCheck Delayed{..} new =
    Delayed{acceptD = acceptD *> new, ..}

addParameterCheck ::
    Delayed captureEnv (a -> b) ->
    DelayedIO a ->
    Delayed captureEnv b
addParameterCheck Delayed{..} new =
    Delayed
        { paramsD = (,) <$> paramsD <*> new
        , serverD = \captures (paramsValue, newValue) headers auth body request ->
            ($ newValue) <$> serverD captures paramsValue headers auth body request
        , ..
        }

addHeaderCheck ::
    Delayed captureEnv (a -> b) ->
    DelayedIO a ->
    Delayed captureEnv b
addHeaderCheck Delayed{..} new =
    Delayed
        { headersD = (,) <$> headersD <*> new
        , serverD = \captures params (headersValue, newValue) auth body request ->
            ($ newValue) <$> serverD captures params headersValue auth body request
        , ..
        }

addAuthCheck ::
    Delayed captureEnv (a -> b) ->
    DelayedIO a ->
    Delayed captureEnv b
addAuthCheck Delayed{..} new =
    Delayed
        { authD = (,) <$> authD <*> new
        , serverD = \captures params headers (authValue, newValue) body request ->
            ($ newValue) <$> serverD captures params headers authValue body request
        , ..
        }

addBodyCheck ::
    Delayed captureEnv (a -> b) ->
    DelayedIO contentType ->
    (contentType -> DelayedIO a) ->
    Delayed captureEnv b
addBodyCheck Delayed{..} newContentD newBodyD =
    Delayed
        { contentD = (,) <$> contentD <*> newContentD
        , bodyD = \(content, newContent) -> (,) <$> bodyD content <*> newBodyD newContent
        , serverD = \captures params headers auth (bodyValue, newValue) request ->
            ($ newValue) <$> serverD captures params headers auth bodyValue request
        , ..
        }

passToServer :: Delayed captureEnv (a -> b) -> (Request -> a) -> Delayed captureEnv b
passToServer Delayed{..} extract =
    Delayed
        { serverD = \captures params headers auth body request ->
            ($ extract request) <$> serverD captures params headers auth body request
        , ..
        }

runDelayed :: Delayed captureEnv a -> captureEnv -> Request -> IO (RouteResult a)
runDelayed Delayed{..} captureEnv = runDelayedIO $ do
    request <- ask
    captures <- capturesD captureEnv
    methodD
    auth <- authD
    acceptD
    content <- contentD
    params <- paramsD
    headers <- headersD
    body <- bodyD content
    liftRouteResult (serverD captures params headers auth body request)

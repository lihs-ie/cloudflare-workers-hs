module Servant.Cloudflare.Workers.ErrorMapping (
    mapExceptionsToServerError,
) where

import Control.Exception (Exception, try)
import Control.Monad.Except (mapExceptT)
import Control.Monad.Reader (mapReaderT)
import Servant.Cloudflare.Workers.Error (ServerError)
import Servant.Cloudflare.Workers.Handler (Handler (Handler, unHandler))

mapExceptionsToServerError ::
    forall e env a.
    (Exception e) =>
    (e -> ServerError) ->
    Handler env a ->
    Handler env a
mapExceptionsToServerError toServerError action =
    Handler (mapReaderT (mapReaderT (mapExceptT catchTypedException)) (unHandler action))
  where
    catchTypedException :: IO (Either ServerError a) -> IO (Either ServerError a)
    catchTypedException ioAction = do
        outcome <- try ioAction
        case outcome of
            Right result -> pure result
            Left (exception :: e) -> pure (Left (toServerError exception))

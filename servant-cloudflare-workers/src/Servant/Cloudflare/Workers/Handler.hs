module Servant.Cloudflare.Workers.Handler (
    Handler (..),
    askExecutionContext,
) where

import Control.Monad.Except (ExceptT, MonadError)
import Control.Monad.IO.Class (MonadIO)
import Control.Monad.Reader (MonadReader (ask), MonadTrans (lift), ReaderT)

import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Servant.Cloudflare.Workers.Error (ServerError)

newtype Handler env a = Handler
    { unHandler :: ReaderT env (ReaderT WorkersExecutionContext (ExceptT ServerError IO)) a
    }
    deriving newtype
        ( Functor
        , Applicative
        , Monad
        , MonadIO
        , MonadError ServerError
        , MonadReader env
        )

askExecutionContext :: Handler env WorkersExecutionContext
askExecutionContext = Handler (lift ask)

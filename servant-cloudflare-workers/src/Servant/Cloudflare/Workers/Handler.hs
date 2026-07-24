module Servant.Cloudflare.Workers.Handler (
    Handler (..),
) where

import Control.Monad.Except (ExceptT, MonadError)
import Control.Monad.IO.Class (MonadIO)
import Control.Monad.Reader (MonadReader, ReaderT)

import Cloudflare.Workers.Reactor (Context)
import Servant.Cloudflare.Workers.Error (ServerError)

newtype Handler env a = Handler
    { unHandler :: ReaderT env (ReaderT Context (ExceptT ServerError IO)) a
    }
    deriving newtype
        ( Functor
        , Applicative
        , Monad
        , MonadIO
        , MonadError ServerError
        , MonadReader env
        )

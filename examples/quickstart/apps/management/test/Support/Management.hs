module Support.Management (runWithoutStorage, clock) where

import Control.Monad.Except (runExceptT)
import Control.Monad.Reader (runReaderT)
import Data.Time
import Quickstart.Management
import Servant.Cloudflare.Workers.Handler
import Servant.Cloudflare.Workers.Error

clock :: UTCTime
clock = UTCTime (fromGregorian 2026 9 7) 0

-- Invalid input must be rejected before touching a Worker binding or crypto.
runWithoutStorage :: Handler ManagementEnv a -> IO (Either ServerError a)
runWithoutStorage action = runExceptT $ runReaderT (runReaderT (unHandler action) env) (error "unexpected execution context access")
  where env = ManagementEnv (error "unexpected D1 access") "admin-subject" (pure clock) (error "unexpected random generation")

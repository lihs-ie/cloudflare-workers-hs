module Support.Delayed.Trace (tracedDelayed, stages) where

import Control.Monad (when)
import Control.Monad.IO.Class (liftIO)
import Data.IORef
import Servant.Cloudflare.Workers.Error (err400)
import Servant.Cloudflare.Workers.Server.Internal.Delayed
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO
import Servant.Cloudflare.Workers.Server.Internal.RouteResult

stages :: [String]
stages = ["capture", "method", "auth", "accept", "content", "params", "headers", "body"]
tracedDelayed :: IORef [String] -> Maybe String -> Delayed () Int
tracedDelayed ref stop =
    Delayed
        (const (step "capture"))
        (step "method")
        (step "auth")
        (step "accept")
        (step "content")
        (step "params")
        (step "headers")
        (const (step "body"))
        (\_ _ _ _ _ _ -> Route 42)
  where
    step name = do
        liftIO (modifyIORef' ref (<> [name]))
        when (stop == Just name) $ delayedFailFatal err400

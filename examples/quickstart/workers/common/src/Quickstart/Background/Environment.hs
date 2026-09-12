module Quickstart.Background.Environment where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace)
import Cloudflare.Workers.Binding.D1 (D1)
import Cloudflare.Workers.Binding.Queue (QueueProducer, QueueBody(QueueJSONBody), queueSendValue, queueSendDefaultOptions)
import Cloudflare.Workers.Binding.R2 (R2Bucket)
import Data.Aeson (ToJSON)
import Data.Text (Text)
import Data.Time (UTCTime)
import Quickstart.Database (jsonText)
import Control.Monad (void)

-- Authentication is performed before constructing an HTTP application's environment.
data BackgroundEnv = BackgroundEnv
  { database :: D1
  , bucket :: R2Bucket
  , clickQueue :: QueueProducer
  , exportQueue :: QueueProducer
  , administrator :: Text
  , currentTime :: IO UTCTime
  , newIdentifier :: IO Text
  , coordinator :: DurableObjectNamespace
  }

sendJSON :: ToJSON a => QueueProducer -> a -> IO ()
sendJSON producer value = void (queueSendValue producer (QueueJSONBody (jsonText value)) queueSendDefaultOptions)

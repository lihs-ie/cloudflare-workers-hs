module Cloudflare.Workers.Binding.Queue (
    QueueProducer (..),
    queueSend,
    queueSendBatch,
) where

import Data.ByteString (ByteString)

data QueueProducer = QueueProducerSTUB deriving stock (Show, Eq)

queueSend :: QueueProducer -> ByteString -> IO ()
queueSend _producer _message = pure ()

queueSendBatch :: QueueProducer -> [ByteString] -> IO ()
queueSendBatch _producer _messages = pure ()

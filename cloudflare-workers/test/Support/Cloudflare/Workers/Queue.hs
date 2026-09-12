module Support.Cloudflare.Workers.Queue (messages) where
import Cloudflare.Workers.Entrypoint.Queue
import Data.ByteString (ByteString)
import Data.IORef

messages :: [ByteString] -> IO (QueueBatch, IORef [String])
messages bodies = do
  settled <- newIORef []
  let message body = QueueMessage "fixture" 0 1 body
        (modifyIORef' settled (<> ["ack"]))
        (\options -> modifyIORef' settled (<> ["retry:" <> show (queueRetryOptionsDelaySeconds options)]))
  pure (QueueBatch "fixture" (map message bodies) Nothing (fail "batch ack must not run") (\_ -> fail "batch retry must not run"), settled)

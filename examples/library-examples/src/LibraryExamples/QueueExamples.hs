module LibraryExamples.QueueExamples (QueueRoutes(..), queueExampleServer) where

import Cloudflare.Workers.Binding.KV (KV)
import Control.Exception (try)
import Cloudflare.Workers.Binding.Queue
import Control.Monad (void)
import Control.Monad.Except (throwError)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8)
import GHC.Generics (Generic)
import LibraryExamples.Jobs (Job(..))
import Servant.API
import Servant.API.Generic ((:-))
import Servant.Cloudflare.Workers.Error qualified as Errors
import Servant.Cloudflare.Workers.Server (Server)

-- Each transport carries the same JSON job schema into the typed consumer.
data QueueRoutes mode = QueueRoutes
  { metricsDiagnostic :: mode :- "diagnostics" :> "metrics" :> Get '[JSON] Value
  , advisoryCheck :: mode :- "advisory" :> "check" :> ReqBody '[JSON] Text :> Post '[JSON] Value
  , sendJob :: mode :- Capture "transport" Text :> ReqBody '[JSON] Job :> Post '[JSON] Value
  } deriving stock (Generic)

queueExampleServer :: QueueProducer -> KV -> Server (NamedRoutes QueueRoutes) env
queueExampleServer producer kv = QueueRoutes
  { metricsDiagnostic = liftIO $ do
      outcome <- try @QueueError (queueMetrics producer)
      pure $ case outcome of
        Right metrics -> object ["status" .= ("supported" :: Text), "metrics" .= metricsJSON metrics]
        Left (QueueMetricsFailed reason) | "unavailable in this runtime" `Text.isInfixOf` reason ->
          object ["status" .= ("unsupported" :: Text), "metrics" .= (Nothing :: Maybe Value)]
        Left _ -> object ["status" .= ("failed" :: Text), "metrics" .= (Nothing :: Maybe Value)]
  , advisoryCheck = \name -> do
      if Text.null name || Text.length name > 80 then throwError Errors.err400 else pure ()
      firstSeen <- liftIO (queueDedupCheck kv ("advisory-example:" <> name))
      pure (object ["firstSeen" .= firstSeen, "exactlyOnce" .= False, "expires" .= False])
  , sendJob = send
  }
  where
  send transport job = do
    let name = identifier job
    if Text.null name || Text.length name > 80 || Text.any (\c -> not (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_')) name || Text.null (payload job)
      then throwError Errors.err400
      else pure ()
    let bytes = Lazy.toStrict (encode job)
        text = decodeUtf8 bytes
        delayed = queueSendDefaultOptions{queueSendOptionsDelaySeconds = Just 1}
        explicitText = queueSendDefaultOptions{queueSendOptionsContentType = Just QueueContentTypeText}
    action <- case transport of
      "bytes-single" -> pure (queueSend producer bytes queueSendDefaultOptions)
      "bytes-batch" -> pure (queueSendBatch producer [(bytes, queueSendDefaultOptions)])
      "text" -> pure (void (queueSendValue producer (QueueTextBody text) explicitText))
      "bytes" -> pure (void (queueSendValue producer (QueueBytesBody bytes) queueSendDefaultOptions))
      "v8" -> pure (void (queueSendValue producer (QueueV8Body bytes) queueSendDefaultOptions))
      "message-delay" -> pure (void (queueSendValue producer (QueueTextBody text) delayed))
      "batch-delay" -> pure (void (queueSendBatchWithOptions producer [(QueueTextBody text, queueSendDefaultOptions)] (QueueBatchOptions (Just 1))))
      _ -> throwError Errors.err400
    liftIO action
    pure (object ["accepted" .= name, "transport" .= transport])

metricsJSON :: QueueMetrics -> Value
metricsJSON metrics = object
  [ "backlogCount" .= queueMetricsBacklogCount metrics
  , "backlogBytes" .= queueMetricsBacklogBytes metrics
  , "oldestMessageTimestamp" .= queueMetricsOldestMessageTimestamp metrics
  ]

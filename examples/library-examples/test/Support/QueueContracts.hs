module Support.QueueContracts (queueContract) where

import Cloudflare.Workers.Binding.Queue
import Cloudflare.Workers.Entrypoint.Queue
import Cloudflare.Workers.Entrypoint.Queue.Typed
import Cloudflare.Workers.Env (BindingEnv)
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Control.Exception (SomeException, try)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.IORef
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)

-- Synthetic boundary input; these results never assert native metrics support.
queueContract :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
queueContract modeRaw input env context = do
  mode <- jsValToText modeRaw
  outcome <- try @SomeException $ case mode of
    "send" -> resultJSON <$> queueSendValue (QueueProducer input) (QueueTextBody "contract") queueSendDefaultOptions
    "send-batch" -> resultJSON <$> queueSendBatchWithOptions (QueueProducer input) [(QueueTextBody "contract", queueSendDefaultOptions)] queueBatchDefaultOptions
    "metrics" -> metricsJSON <$> queueMetrics (QueueProducer input)
    "default-json" -> do
      count <- newIORef (0 :: Int)
      createJSONQueueHandler (\_ (_ :: Value) (_ :: BindingEnv '[] '[] '[]) _ -> modifyIORef' count (+1)) input env context
      processed <- readIORef count
      pure (object ["processed" .= processed])
    "default-helper" -> do
      count <- newIORef (0 :: Int)
      createQueueHandler (\batch (_ :: BindingEnv '[] '[] '[]) _ ->
        consumeJSONMessages (\_ (_ :: Value) -> modifyIORef' count (+1)) batch) input env context
      processed <- readIORef count
      pure (object ["processed" .= processed])
    _ -> do
      observed <- newIORef (Nothing :: Maybe QueueMetrics)
      createQueueHandler (\batch (_ :: BindingEnv '[] '[] '[]) _ -> do
        writeIORef observed (queueBatchMetrics batch)
        case mode of
          "ack-all" -> queueBatchAckAll batch
          "retry-all" -> queueBatchRetryAll batch (QueueRetryOptions (Just 1))
          _ -> pure ()) input env context
      value <- readIORef observed
      pure (object ["metrics" .= fmap metricsJSON value])
  textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ case outcome of
    Left _ -> object ["ok" .= False]
    Right value -> object ["ok" .= True, "value" .= value]

resultJSON :: QueueSendResult -> Value
resultJSON result = object ["source" .= show (queueSendResultSource result), "metrics" .= fmap metricsJSON (queueSendResultMetrics result)]

metricsJSON :: QueueMetrics -> Value
metricsJSON metrics = object
  [ "backlogCount" .= queueMetricsBacklogCount metrics
  , "backlogBytes" .= queueMetricsBacklogBytes metrics
  , "oldestMessageTimestamp" .= queueMetricsOldestMessageTimestamp metrics
  ]

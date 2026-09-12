module Cloudflare.Workers.Entrypoint.Queue (
    QueueMessage (..),
    QueueBatch (..),
    QueueRetryOptions (..),
    QueueConsumer,
    createQueueHandler,
) where

import Cloudflare.Workers.Binding.Queue (
    QueueError (QueueValidationFailed, QueueMetricsFailed),
    QueueMetrics (QueueMetrics),
    QueueValidationFailure (QueueBatchDelayOutOfRange),
    queueBatchDelayIsValid,
 )
import Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv, BuildDOSEnv)
import Cloudflare.Workers.Internal.FFI.Queue (
    queueBatchAckAllViaFFI,
    queueBatchMessageJSValsViaFFI,
    queueBatchMetricsViaFFI,
    queueBatchQueueNameViaFFI,
    queueBatchRetryAllViaFFI,
    queueMessageAckViaFFI,
    queueMessageAttemptsViaFFI,
    queueMessageBodyBytesViaFFI,
    queueMessageIdViaFFI,
    queueMessageRetryViaFFI,
    queueMessageTimestampMillisViaFFI,
 )
import Cloudflare.Workers.Reactor (WorkersExecutionContext (WorkersExecutionContext))
import Control.Exception (throwIO)
import Data.ByteString (ByteString)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

data QueueMessage = QueueMessage
    { queueMessageID :: Text
    , queueMessageTimestamp :: Integer
    , queueMessageAttempts :: Int
    , queueMessageBody :: ByteString
    , queueMessageAck :: IO ()
    , queueMessageRetry :: QueueRetryOptions -> IO ()
    }

data QueueBatch = QueueBatch
    { queueBatchQueueName :: Text
    , queueBatchMessages :: [QueueMessage]
    , queueBatchMetrics :: Maybe QueueMetrics
    , queueBatchAckAll :: IO ()
    , queueBatchRetryAll :: QueueRetryOptions -> IO ()
    }

newtype QueueRetryOptions = QueueRetryOptions
    { queueRetryOptionsDelaySeconds :: Maybe Int
    }
    deriving stock (Show, Eq)

type QueueConsumer env = QueueBatch -> env -> WorkersExecutionContext -> IO ()

queueMessageFromJSVal :: JSVal -> IO QueueMessage
queueMessageFromJSVal messageJSVal = do
    messageID <- queueMessageIdViaFFI messageJSVal
    timestampMillis <- queueMessageTimestampMillisViaFFI messageJSVal
    attempts <- queueMessageAttemptsViaFFI messageJSVal
    body <- queueMessageBodyBytesViaFFI messageJSVal
    pure
        QueueMessage
            { queueMessageID = messageID
            , queueMessageTimestamp = timestampMillis
            , queueMessageAttempts = attempts
            , queueMessageBody = body
            , queueMessageAck = queueMessageAckViaFFI messageJSVal
            , queueMessageRetry = validatedRetry (queueMessageRetryViaFFI messageJSVal)
            }

queueBatchFromJSVal :: JSVal -> IO QueueBatch
queueBatchFromJSVal batchJSVal = do
    queueName <- queueBatchQueueNameViaFFI batchJSVal
    messageJSVals <- queueBatchMessageJSValsViaFFI batchJSVal
    messages <- traverse queueMessageFromJSVal messageJSVals
    metrics <- queueBatchMetricsViaFFI batchJSVal >>= either (throwIO . QueueMetricsFailed) pure
    pure
        QueueBatch
            { queueBatchQueueName = queueName
            , queueBatchMessages = messages
            , queueBatchMetrics = fmap (\(count, bytes, timestamp) -> QueueMetrics count bytes timestamp) metrics
            , queueBatchAckAll = queueBatchAckAllViaFFI batchJSVal
            , queueBatchRetryAll = validatedRetry (queueBatchRetryAllViaFFI batchJSVal)
            }

createQueueHandler ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    QueueConsumer (BindingEnv kvs dos bindings) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createQueueHandler handler batchJSVal envJSVal contextJSVal = do
    batch <- queueBatchFromJSVal batchJSVal
    bindings <- bindingEnvFromJSVal envJSVal
    handler batch bindings (WorkersExecutionContext contextJSVal)

validatedRetry :: (Maybe Int -> IO ()) -> QueueRetryOptions -> IO ()
validatedRetry retryAction options = do
    let delay = queueRetryOptionsDelaySeconds options
    if queueBatchDelayIsValid delay
        then retryAction delay
        else case delay of
            Just seconds -> throwIO (QueueValidationFailed (QueueBatchDelayOutOfRange seconds))
            Nothing -> retryAction Nothing

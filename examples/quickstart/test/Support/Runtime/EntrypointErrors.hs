{-# LANGUAGE DataKinds #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}

module Support.Runtime.EntrypointErrors (entrypointErrorsProbe) where

import Cloudflare.Workers.Binding.Queue
import Cloudflare.Workers.Binding.Var (Var, unVar)
import Cloudflare.Workers.Binding.Workflow (WorkflowIdentifier (..))
import Cloudflare.Workers.Entrypoint.DurableObject (WebSocketError (..), WebSocketMessagePayload (..))
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Entrypoint.Queue
import Cloudflare.Workers.Entrypoint.Queue.Typed
import Cloudflare.Workers.Entrypoint.Scheduled
import Cloudflare.Workers.Entrypoint.Tail
import Cloudflare.Workers.Entrypoint.Workflow (WorkflowEvent (..))
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Cloudflare.Workers.HTTP (ResponseBody (..), Status (..), createResponse)
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Internal.FFI.Reactor (emitLogViaFFI, tailLogViaFFI)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Reactor (WorkersExecutionContext (..), initializeRTS, passThroughOnException, waitUntil)
import Control.Concurrent.MVar (newEmptyMVar, putMVar, takeMVar)
import Control.Exception (SomeException, displayException, fromException, toException, try)
import Control.Monad (when)
import Data.Aeson (Value, encode, object, omittedField, (.=))
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as Lazy
import Data.IORef
import Data.List (intercalate, nub)
import Data.Maybe (isJust)
import Data.Proxy (Proxy (..))
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)

type ConfiguredEnv = BindingEnv '[] '[] '[ '("CONFIG", Var)]

-- Consume actual handler arguments, so metadata assertions observe decoded values.
entrypointErrorsProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
entrypointErrorsProbe modeValue event environment context = do
    mode <- jsValToText modeValue
    observed <- newIORef ([] :: [Value])
    let record value = modifyIORef' observed (<> [value])
        queueHandler batch _ _ = do
            record $ object ["queue" .= queueBatchQueueName batch, "metrics" .= fmap (\m -> (queueMetricsBacklogCount m, queueMetricsBacklogBytes m, queueMetricsOldestMessageTimestamp m)) (queueBatchMetrics batch)]
            mapM_
                ( \message -> do
                    record $ object ["identifier" .= queueMessageID message, "timestamp" .= queueMessageTimestamp message, "attempts" .= queueMessageAttempts message, "bytes" .= Bytes.unpack (queueMessageBody message)]
                    case mode of
                        "queue-negative" -> queueMessageRetry message (QueueRetryOptions (Just (-1)))
                        "queue-excess" -> queueMessageRetry message (QueueRetryOptions (Just 86401))
                        _ -> queueMessageAck message
                )
                (queueBatchMessages batch)
            when (mode == "queue-throw") $ fail "consumer failed"
        scheduledHandler controller _ _ = do
            record $ object ["cron" .= scheduledControllerCron controller, "time" .= scheduledControllerScheduledTime controller]
            scheduledControllerNoRetry controller
            when (mode == "scheduled-throw") $ fail "scheduled handler failed"
        tailHandler events _ _ = do
            record $ object ["events" .= map (\e -> (tailEventScriptName e, tailEventOutcome e, tailEventEventTimestamp e)) events]
            when (mode == "tail-throw") $ fail "tail handler failed"
        typedAction :: QueueMessage -> Int -> BindingEnv '[] '[] '[] -> WorkersExecutionContext -> IO ()
        typedAction message value _ executionContext = do
            passThroughOnException executionContext
            record $ object ["identifier" .= queueMessageID message, "decoded" .= value]
        typedPolicy message _ _ executionContext = do
            passThroughOnException executionContext
            record $ object ["rejected" .= queueMessageID message]
            pure AcknowledgeMessage
        configuredScheduled :: ScheduledHandler ConfiguredEnv
        configuredScheduled controller env executionContext = do
            passThroughOnException executionContext
            record $ object ["config" .= unVar (getBinding (Proxy @"CONFIG") env), "cron" .= scheduledControllerCron controller]
        configuredTail :: TailHandler ConfiguredEnv
        configuredTail events env executionContext = do
            passThroughOnException executionContext
            record $ object ["config" .= unVar (getBinding (Proxy @"CONFIG") env), "outcomes" .= map tailEventOutcome events]
        configuredAction :: QueueMessage -> Int -> ConfiguredEnv -> WorkersExecutionContext -> IO ()
        configuredAction message value env executionContext = do
            passThroughOnException executionContext
            record $ object ["config" .= unVar (getBinding (Proxy @"CONFIG") env), "identifier" .= queueMessageID message, "decoded" .= value]
        configuredPolicy message failure env executionContext = do
            passThroughOnException executionContext
            record $ object ["config" .= unVar (getBinding (Proxy @"CONFIG") env), "identifier" .= queueMessageID message, "failure" .= show failure]
            pure AcknowledgeMessage
        sendResult result =
            record $
                object
                    [ "source" .= show (queueSendResultSource result)
                    , "hasMetrics" .= isJust (queueSendResultMetrics result)
                    , "receipt" .= show result
                    , "matchesBatchReceipt" .= (result == QueueSendResult QueueSendBatchMetricsSource Nothing)
                    , "differsFromSendReceipt" .= (result /= QueueSendResult QueueSendMetricsSource Nothing)
                    ]
        fetchHandler _ _ _ = do
            record $ object ["handled" .= True]
            pure $ createResponse (Status 204) (headersFromList []) (ResponseBodyBytes "")
        execute
            | mode == "public-instance-contracts" = mapM_ record publicInstanceContracts
            | mode == "configured-scheduled" = createScheduledHandler configuredScheduled event environment context
            | mode == "configured-tail" = createTailHandler configuredTail event environment context
            | mode == "configured-typed" = createJSONQueueHandlerWith configuredPolicy configuredAction event environment context
            | mode == "queue-batch-rejection" = queueSendBatchWithOptions (QueueProducer event) [(QueueTextBody "payload", queueSendDefaultOptions)] queueBatchDefaultOptions >>= sendResult
            | mode == "queue-message-invalid" = queueSendValue (QueueProducer event) (QueueTextBody "payload") (QueueSendOptions Nothing (Just (-1))) >>= sendResult
            | mode == "queue-batch-invalid" = queueSendBatchWithOptions (QueueProducer event) [] queueBatchDefaultOptions >>= sendResult
            | mode == "queue-send-receipt" = queueSendValue (QueueProducer event) (QueueTextBody "receipt") queueSendDefaultOptions >>= sendResult
            | mode == "queue-entry-delay" = queueSendBatchWithOptions (QueueProducer event) [(QueueTextBody "first", QueueSendOptions Nothing (Just 7)), (QueueTextBody "second", queueSendDefaultOptions)] queueBatchDefaultOptions >>= sendResult
            | mode == "tail-log" = tailLogViaFFI "entrypoint-log-test"
            | mode == "structured-log" = emitLogViaFFI "{\"message\":\"entrypoint-log-test\"}"
            | mode == "fetch" = do
                response <- createFetchHandler @'[] @'[] @'[] fetchHandler event environment context
                status <- responseStatus response
                record $ object ["status" .= status]
            | mode == "queue-typed" = createJSONQueueHandlerWith typedPolicy typedAction event environment context
            | mode == "initialize" = initializeRTS >>= \() -> record (object ["initialized" .= True])
            | mode == "context-pass" = passThroughOnException (WorkersExecutionContext context)
            | mode == "context-wait" = do
                completed <- newEmptyMVar
                waitUntil (WorkersExecutionContext context) (record (object ["deferred" .= True]) >> putMVar completed ())
                takeMVar completed
            | mode == "producer-metrics" = do
                metrics <- queueMetrics (QueueProducer event)
                record $ object ["count" .= queueMetricsBacklogCount metrics, "bytes" .= queueMetricsBacklogBytes metrics, "timestamp" .= queueMetricsOldestMessageTimestamp metrics]
            | mode == "scheduled" || mode == "scheduled-throw" = createScheduledHandler @'[] @'[] @'[] scheduledHandler event environment context
            | mode == "tail" || mode == "tail-throw" = createTailHandler @'[] @'[] @'[] tailHandler event environment context
            | otherwise = createQueueHandler @'[] @'[] @'[] queueHandler event environment context
    result <- try @SomeException execute
    case result of
        Left exception -> case fromException exception of
            Just (QueueSendBatchFailed rejection) -> record $ object ["kind" .= show (queueRejectionKind rejection), "information" .= queueRejectionInformation rejection]
            Just (QueueValidationFailed failure) -> record $ object ["validation" .= show failure]
            _ -> pure ()
        Right () -> pure ()
    values <- readIORef observed
    textToJSVal $
        Text.decodeUtf8 $
            Lazy.toStrict $
                encode $
                    object
                        ["ok" .= either (const False) (const True) result, "message" .= either displayException (const "") result, "observed" .= values]

foreign import javascript unsafe "$1.status"
    responseStatus :: JSVal -> IO Int

-- Consumers use these instances for configuration diffing, typed error matching,
-- and batch diagnostics. Distinct domain samples must not compare equal; the
-- explicit Show methods must preserve suffixes and agree with list diagnostics.
instanceContract :: (Eq a, Show a) => String -> [a] -> Value
instanceContract name values =
    object
        [ "name" .= name
        , "reflexive" .= all (\value -> value == value && not (value /= value)) values
        , "distinct" .= and [left /= right && not (left == right) | (i, left) <- zip [0 :: Int ..] values, (j, right) <- zip [0 :: Int ..] values, i /= j]
        , "showCoherent" .= all (\value -> shows value " suffix" == show value <> " suffix") values
        , "listCoherent" .= (showList values " suffix" == "[" <> intercalate "," (map show values) <> "] suffix")
        , "diagnosticsDistinct" .= (length (nub (map show values)) == length values)
        , "diagnostics" .= showList values ""
        ]

publicInstanceContracts :: [Value]
publicInstanceContracts =
    [ instanceContract "content-types" [QueueContentTypeJSON, QueueContentTypeText, QueueContentTypeBytes, QueueContentTypeV8]
    , instanceContract "send-options" [QueueSendOptions Nothing Nothing, QueueSendOptions (Just QueueContentTypeText) Nothing, QueueSendOptions Nothing (Just 0), QueueSendOptions Nothing (Just 1)]
    , instanceContract "batch-options" [QueueBatchOptions Nothing, QueueBatchOptions (Just 1), QueueBatchOptions (Just 2)]
    , instanceContract "metric-sources" [QueueProducerMetricsSource, QueueSendMetricsSource, QueueSendBatchMetricsSource, QueueConsumerMetricsSource]
    , instanceContract "metrics" [QueueMetrics 0 0 Nothing, QueueMetrics 1 0 Nothing, QueueMetrics 0 1 Nothing, QueueMetrics 0 0 (Just 1), QueueMetrics 0 0 (Just 2)]
    , instanceContract "send-results" [QueueSendResult QueueSendMetricsSource Nothing, QueueSendResult QueueSendBatchMetricsSource Nothing, QueueSendResult QueueSendMetricsSource (Just (QueueMetrics 1 2 Nothing)), QueueSendResult QueueSendMetricsSource (Just (QueueMetrics 2 2 Nothing))]
    , instanceContract "validation-failures" [QueueMessageTooLarge 1, QueueMessageTooLarge 2, QueueDelayOutOfRange (-1), QueueBatchEmpty, QueueBatchTooManyMessages 101, QueueBatchMessageTooLarge 0 120000, QueueBatchMessageTooLarge 1 120000, QueueBatchMessageTooLarge 0 120001, QueueBatchTotalTooLarge 256001, QueueBatchMessageDelayOutOfRange 0 (-1), QueueBatchMessageDelayOutOfRange 1 (-1), QueueBatchMessageDelayOutOfRange 0 86401, QueueBatchDelayOutOfRange 0]
    , instanceContract "rejection-kinds" [QueueBodyTooLargeRejection, QueueBatchCountOutOfRangeRejection, QueueBatchBytesTooLargeRejction, QueueDelayOutOfRangeRejection, QueueInvalidBodyRejection, QueueOtherRejection]
    , instanceContract "rejections" [QueueRejection QueueOtherRejection "first", QueueRejection QueueOtherRejection "second", QueueRejection QueueInvalidBodyRejection "first"]
    , instanceContract "queue-errors" [QueueSendFailed rejection, QueueSendBatchFailed rejection, QueueMetricsFailed "first", QueueMetricsFailed "second", QueueValidationFailed QueueBatchEmpty, QueueInvalidMetrics (QueueMetrics (-1) 0 Nothing)]
    , instanceContract "retry-options" [QueueRetryOptions Nothing, QueueRetryOptions (Just 1), QueueRetryOptions (Just 2)]
    , instanceContract "failure-dispositions" [AcknowledgeMessage, RetryMessage (QueueRetryOptions Nothing), RetryMessage (QueueRetryOptions (Just 1))]
    , instanceContract "socket-payloads" [WebSocketTextMessage "a", WebSocketTextMessage "b", WebSocketBinaryMessage (Bytes.pack [0]), WebSocketBinaryMessage (Bytes.pack [255])]
    , instanceContract "socket-errors" [WebSocketSendFailed "first", WebSocketSendFailed "second", WebSocketMessageTooLarge 1, WebSocketMessageTooLarge 2]
    , instanceContract "tail-events" [TailEvent Nothing "ok" Nothing, TailEvent (Just "worker") "ok" Nothing, TailEvent Nothing "exception" Nothing, TailEvent Nothing "ok" (Just 1), TailEvent Nothing "ok" (Just 2)]
    , instanceContract "workflow-events" [WorkflowEvent (1 :: Int) (WorkflowIdentifier "one") "time", WorkflowEvent 2 (WorkflowIdentifier "one") "time", WorkflowEvent 1 (WorkflowIdentifier "two") "time", WorkflowEvent 1 (WorkflowIdentifier "one") "later"]
    , failureDiagnosticContract
    , object ["name" .= ("workflow-required-field" :: String), "missingRejected" .= (omittedField @(WorkflowEvent Int) == Nothing)]
    ]
  where
    rejection = QueueRejection QueueOtherRejection "native failure"

failureDiagnosticContract :: Value
failureDiagnosticContract =
    let failures = [QueueDecodeFailure "bad JSON", QueueDecodeException (toException (userError "decode failed")), QueueProcessingFailure (toException (userError "handler failed"))]
     in object
            [ "name" .= ("message-failures" :: String)
            , "showCoherent" .= all (\value -> shows value " suffix" == show value <> " suffix") failures
            , "listCoherent" .= (showList failures " suffix" == "[" <> intercalate "," (map show failures) <> "] suffix")
            , "diagnostics" .= showList failures ""
            ]

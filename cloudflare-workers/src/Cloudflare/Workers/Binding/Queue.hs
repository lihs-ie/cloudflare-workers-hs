module Cloudflare.Workers.Binding.Queue (
    QueueProducer (..),
    QueueContentType (..),
    QueueBody (..),
    queueBodyContentType,
    queueBodyByteLength,
    QueueSendOptions (..),
    QueueBatchOptions (..),
    QueueMetricsSource (..),
    QueueMetrics (..),
    queueMetricsIsValid,
    QueueSendResult (..),
    QueueRejectionKind (..),
    QueueRejection (..),
    classifyQueueRejection,
    QueueValidationFailure (..),
    QueueError (..),
    queueMessageSerializedTotalSizeIsValid,
    queueBatchSerializedTotalSizeIsValid,
    queueSendDefaultOptions,
    queueBatchDefaultOptions,
    queueSendDelayIsValid,
    queueBatchDelayIsValid,
    validateQueueMessage,
    validateQueueBatch,
    queueMetrics,
    queueSend,
    queueSendValue,
    queueSendBatch,
    queueSendBatchWithOptions,
    queueDedupCheck,
) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectValue (DurableObjectValue))
import Cloudflare.Workers.Binding.KV (
    KV,
    KVPutValue (KVPutBytes),
    KVReadType (KVReadArrayBuffer),
    kvGet,
    kvPut,
    kvPutDefaultOptions,
    kvReadDefaultOptions,
 )
import Cloudflare.Workers.Internal.FFI.Queue (QueueBodyViaFFI (QueueBytesViaFFI, QueueJSONViaFFI, QueueTextViaFFI, QueueV8ViaFFI), QueueMetricsViaFFI, queueMetricsViaFFI, sendBatchResultViaFFI, sendResultViaFFI)
import Control.Exception (Exception, throwIO)
import Data.Bifunctor (Bifunctor (first))
import Data.ByteString (ByteString)
import Data.ByteString qualified as ByteString
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import GHC.Wasm.Prim (JSVal)

newtype QueueProducer = QueueProducer JSVal

data QueueContentType
    = QueueContentTypeJSON
    | QueueContentTypeText
    | QueueContentTypeBytes
    | QueueContentTypeV8
    deriving stock (Show, Eq)

data QueueBody
    = QueueTextBody Text
    | QueueBytesBody ByteString
    | QueueJSONBody Text
    | QueueV8Body ByteString
    | QueueV8StructuredClone DurableObjectValue

queueBodyByteLength :: QueueBody -> Maybe Int
queueBodyByteLength (QueueTextBody value) = Just (ByteString.length (TextEncoding.encodeUtf8 value))
queueBodyByteLength (QueueBytesBody value) = Just (ByteString.length value)
queueBodyByteLength (QueueJSONBody _) = Nothing
queueBodyByteLength (QueueV8Body _) = Nothing
queueBodyByteLength (QueueV8StructuredClone _) = Nothing

queueBodyContentType :: QueueBody -> QueueContentType
queueBodyContentType (QueueTextBody _) = QueueContentTypeText
queueBodyContentType (QueueBytesBody _) = QueueContentTypeBytes
queueBodyContentType (QueueJSONBody _) = QueueContentTypeJSON
queueBodyContentType (QueueV8Body _) = QueueContentTypeV8
queueBodyContentType (QueueV8StructuredClone _) = QueueContentTypeV8

data QueueSendOptions = QueueSendOptions
    { queueSendOptionsContentType :: Maybe QueueContentType
    , queueSendOptionsDelaySeconds :: Maybe Int
    }
    deriving stock (Show, Eq)

newtype QueueBatchOptions = QueueBatchOptions
    { queueBatchOptionsDelaySeconds :: Maybe Int
    }
    deriving stock (Show, Eq)

data QueueMetricsSource
    = QueueProducerMetricsSource
    | QueueSendMetricsSource
    | QueueSendBatchMetricsSource
    | QueueConsumerMetricsSource
    deriving stock (Show, Eq)

data QueueMetrics = QueueMetrics
    { queueMetricsBacklogCount :: Integer
    , queueMetricsBacklogBytes :: Integer
    , queueMetricsOldestMessageTimestamp :: Maybe Integer
    }
    deriving stock (Show, Eq)

queueMetricsIsValid :: QueueMetrics -> Bool
queueMetricsIsValid metrics =
    queueMetricsBacklogCount metrics >= 0 && queueMetricsBacklogBytes metrics >= 0

-- | Metrics are absent when the runtime resolves a successful send with void.
-- Metrics-capable runtimes retain their actual response without fabricated values.
data QueueSendResult = QueueSendResult
    { queueSendResultSource :: QueueMetricsSource
    , queueSendResultMetrics :: Maybe QueueMetrics
    }
    deriving stock (Show, Eq)

data QueueValidationFailure
    = QueueMessageTooLarge Int
    | QueueDelayOutOfRange Int
    | QueueBatchEmpty
    | QueueBatchTooManyMessages Int
    | QueueBatchMessageTooLarge Int Int
    | QueueBatchTotalTooLarge Int
    | QueueBatchMessageDelayOutOfRange Int Int
    | QueueBatchDelayOutOfRange Int
    deriving stock (Show, Eq)

data QueueRejectionKind
    = QueueBodyTooLargeRejection
    | QueueBatchCountOutOfRangeRejection
    | QueueBatchBytesTooLargeRejction
    | QueueDelayOutOfRangeRejection
    | QueueInvalidBodyRejection
    | QueueOtherRejection
    deriving stock (Show, Eq)

data QueueRejection = QueueRejection
    { queueRejectionKind :: QueueRejectionKind
    , queueRejectionInformation :: Text
    }
    deriving stock (Show, Eq)

classifyQueueRejection :: Text -> QueueRejection
classifyQueueRejection information = QueueRejection kind information
  where
    lowered = Text.toLower information
    mentions needle = needle `Text.isInfixOf` lowered
    kind
        | mentions "json" || mentions "structured clone" = QueueInvalidBodyRejection
        | mentions "delay" = QueueDelayOutOfRangeRejection
        | (mentions "batch" || mentions "messages") && (mentions "count" || mentions "100") = QueueBatchCountOutOfRangeRejection
        | mentions "batch" && (mentions "total size" || mentions "total bytes" || mentions "batch bytes") = QueueBatchBytesTooLargeRejction
        | mentions "128" || mentions "too large" || mentions "size" = QueueBodyTooLargeRejection
        | otherwise = QueueOtherRejection

data QueueError
    = QueueSendFailed QueueRejection
    | QueueSendBatchFailed QueueRejection
    | QueueMetricsFailed Text
    | QueueValidationFailed QueueValidationFailure
    | QueueInvalidMetrics QueueMetrics
    deriving stock (Show, Eq)

instance Exception QueueError

queueSendDefaultOptions :: QueueSendOptions
queueSendDefaultOptions = QueueSendOptions Nothing Nothing

queueBatchDefaultOptions :: QueueBatchOptions
queueBatchDefaultOptions = QueueBatchOptions Nothing

queueSendDelayIsValid :: Maybe Int -> Bool
queueSendDelayIsValid Nothing = True
queueSendDelayIsValid (Just seconds) = seconds >= 0 && seconds <= 86400

queueBatchDelayIsValid :: Maybe Int -> Bool
queueBatchDelayIsValid Nothing = True
queueBatchDelayIsValid (Just seconds) = seconds >= 1 && seconds <= 86400

queueMessageSerializedTotalSizeIsValid :: Int -> Bool
queueMessageSerializedTotalSizeIsValid byteCount = byteCount >= 0 && byteCount < 120000

queueBatchSerializedTotalSizeIsValid :: Int -> Bool
queueBatchSerializedTotalSizeIsValid byteCount = byteCount >= 0 && byteCount <= 256000

validateQueueMessage :: QueueBody -> QueueSendOptions -> Either QueueValidationFailure ()
validateQueueMessage body options
    | Just byteCount <- queueBodyByteLength body
    , not (queueMessageSerializedTotalSizeIsValid byteCount) =
        Left (QueueMessageTooLarge byteCount)
    | Just seconds <- queueSendOptionsDelaySeconds options
    , not (queueSendDelayIsValid (Just seconds)) =
        Left (QueueDelayOutOfRange seconds)
    | otherwise = Right ()

validateQueueBatch :: [(QueueBody, QueueSendOptions)] -> QueueBatchOptions -> Either QueueValidationFailure ()
validateQueueBatch messages batchOptions
    | null messages = Left QueueBatchEmpty
    | length messages > 100 = Left (QueueBatchTooManyMessages (length messages))
    | Just (index, byteCount) <- firstOversized messages = Left (QueueBatchMessageTooLarge index byteCount)
    | Just totalBytes <- knownTotalBytes
    , not (queueBatchSerializedTotalSizeIsValid totalBytes) =
        Left (QueueBatchTotalTooLarge totalBytes)
    | Just (index, seconds) <- firstInvalidMessageDelay messages = Left (QueueBatchMessageDelayOutOfRange index seconds)
    | Just seconds <- queueBatchOptionsDelaySeconds batchOptions
    , not (queueBatchDelayIsValid (Just seconds)) =
        Left (QueueBatchDelayOutOfRange seconds)
    | otherwise = Right ()
  where
    knownTotalBytes = sum <$> traverse (queueBodyByteLength . fst) messages
    firstOversized = findIndexed (\(body, _) -> maybe False (not . queueMessageSerializedTotalSizeIsValid) (queueBodyByteLength body)) (fromMaybe 0 . queueBodyByteLength . fst)
    firstInvalidMessageDelay =
        findIndexed
            (\(_, options) -> not (queueSendDelayIsValid (queueSendOptionsDelaySeconds options)))
            (fromMaybe 0 . queueSendOptionsDelaySeconds . snd)

findIndexed :: (a -> Bool) -> (a -> Int) -> [a] -> Maybe (Int, Int)
findIndexed predicate measure = go 0
  where
    go _ [] = Nothing
    go index (x : xs)
        | predicate x = Just (index, measure x)
        | otherwise = go (index + 1) xs

queueMetrics :: QueueProducer -> IO QueueMetrics
queueMetrics (QueueProducer producerJSVal) = do
    outcome <- queueMetricsViaFFI producerJSVal
    either (throwIO . QueueMetricsFailed) validateMetrics outcome

queueSend :: QueueProducer -> ByteString -> QueueSendOptions -> IO ()
queueSend producer bytes options = do
    _ <- queueSendValue producer (QueueBytesBody bytes) options
    pure ()

queueSendValue :: QueueProducer -> QueueBody -> QueueSendOptions -> IO QueueSendResult
queueSendValue (QueueProducer producerJSVal) body options = do
    either (throwIO . QueueValidationFailed) pure (validateQueueMessage body options)
    let (wireBody, contentType) = queueBodyWire body
        resolvedContentType = fromMaybe contentType (queueSendOptionsContentType options)
    outcome <- sendResultViaFFI producerJSVal wireBody (queueContentTypeTag resolvedContentType) (queueSendOptionsDelaySeconds options)
    metrics <- either (throwIO . QueueSendFailed . classifyQueueRejection) (traverse validateMetrics) outcome
    pure (QueueSendResult QueueSendMetricsSource metrics)

queueSendBatch :: QueueProducer -> [(ByteString, QueueSendOptions)] -> IO ()
queueSendBatch producer messages = do
    _ <- queueSendBatchWithOptions producer (map (first QueueBytesBody) messages) queueBatchDefaultOptions
    pure ()

queueSendBatchWithOptions :: QueueProducer -> [(QueueBody, QueueSendOptions)] -> QueueBatchOptions -> IO QueueSendResult
queueSendBatchWithOptions (QueueProducer producerJSVal) messages batchOptions = do
    either (throwIO . QueueValidationFailed) pure (validateQueueBatch messages batchOptions)
    let wireMessages = map toWireEntry messages
    outcome <- sendBatchResultViaFFI producerJSVal wireMessages (queueBatchOptionsDelaySeconds batchOptions)
    metrics <- either (throwIO . QueueSendBatchFailed . classifyQueueRejection) (traverse validateMetrics) outcome
    pure (QueueSendResult QueueSendBatchMetricsSource metrics)
  where
    toWireEntry (body, options) =
        let (wireBody, contentType) = queueBodyWire body
            resolvedContentType = fromMaybe contentType (queueSendOptionsContentType options)
         in (wireBody, queueContentTypeTag resolvedContentType, queueSendOptionsDelaySeconds options)

queueDedupCheck :: KV -> Text -> IO Bool
queueDedupCheck kv messageIdentifier = do
    let dedupKey = "queue-dedup:" <> messageIdentifier
    existingMarker <- kvGet kv dedupKey KVReadArrayBuffer kvReadDefaultOptions
    case existingMarker of
        Just _ -> pure False
        Nothing -> do
            kvPut kv dedupKey (KVPutBytes "1") kvPutDefaultOptions
            pure True

queueContentTypeTag :: QueueContentType -> Text
queueContentTypeTag QueueContentTypeJSON = "json"
queueContentTypeTag QueueContentTypeText = "text"
queueContentTypeTag QueueContentTypeBytes = "bytes"
queueContentTypeTag QueueContentTypeV8 = "v8"

queueBodyWire :: QueueBody -> (QueueBodyViaFFI, QueueContentType)
queueBodyWire (QueueTextBody value) = (QueueTextViaFFI value, QueueContentTypeText)
queueBodyWire (QueueBytesBody value) = (QueueBytesViaFFI value, QueueContentTypeBytes)
queueBodyWire (QueueJSONBody value) = (QueueJSONViaFFI value, QueueContentTypeJSON)
queueBodyWire (QueueV8Body value) = (QueueBytesViaFFI value, QueueContentTypeV8)
queueBodyWire (QueueV8StructuredClone (DurableObjectValue valueJSVal)) = (QueueV8ViaFFI valueJSVal, QueueContentTypeV8)

validateMetrics :: QueueMetricsViaFFI -> IO QueueMetrics
validateMetrics rawMetrics = do
    let metrics = fromMetricsViaFFI rawMetrics
    if queueMetricsIsValid metrics then pure metrics else throwIO (QueueInvalidMetrics metrics)

fromMetricsViaFFI :: QueueMetricsViaFFI -> QueueMetrics
fromMetricsViaFFI (backlogCount, backlogBytes, oldestTimestamp) =
    QueueMetrics backlogCount backlogBytes oldestTimestamp

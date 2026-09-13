module Cloudflare.Workers.Internal.FFI.Queue (
    QueueMetricsViaFFI,
    QueueBodyViaFFI (..),
    sendViaFFI,
    sendResultViaFFI,
    sendBatchViaFFI,
    sendBatchResultViaFFI,
    queueMetricsViaFFI,
    queueBatchQueueNameViaFFI,
    queueBatchMessageJSValsViaFFI,
    queueBatchAckAllViaFFI,
    queueBatchRetryAllViaFFI,
    queueBatchMetricsViaFFI,
    queueMessageIdViaFFI,
    queueMessageTimestampMillisViaFFI,
    queueMessageAttemptsViaFFI,
    queueMessageBodyBytesViaFFI,
    queueMessageAckViaFFI,
    queueMessageRetryViaFFI,
) where

import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Monad (forM, void)
import Data.ByteString (ByteString)
import Data.Foldable (for_)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

type QueueMetricsViaFFI = (Integer, Integer, Maybe Integer)

data QueueBodyViaFFI
    = QueueTextViaFFI Text
    | QueueBytesViaFFI ByteString
    | QueueJSONViaFFI Text
    | QueueV8ViaFFI JSVal

buildQueueMessageBodyJSVal :: QueueBodyViaFFI -> IO (Either Text JSVal)
buildQueueMessageBodyJSVal (QueueTextViaFFI value) = Right <$> textToJSVal value
buildQueueMessageBodyJSVal (QueueBytesViaFFI value) = Right <$> byteStringToJSByteArray value
buildQueueMessageBodyJSVal (QueueJSONViaFFI value) = do
    valueJSVal <- textToJSVal value
    decodeEnveloped pure =<< jsJSONParseEnveloped valueJSVal
buildQueueMessageBodyJSVal (QueueV8ViaFFI value) = pure (Right value)

sendViaFFI :: JSVal -> QueueBodyViaFFI -> Text -> Maybe Int -> IO (Either Text ())
sendViaFFI producerJSVal messageBody contentTypeTag maybeDelaySeconds = do
    fmap void (sendResultViaFFI producerJSVal messageBody contentTypeTag maybeDelaySeconds)

sendResultViaFFI :: JSVal -> QueueBodyViaFFI -> Text -> Maybe Int -> IO (Either Text (Maybe QueueMetricsViaFFI))
sendResultViaFFI producerJSVal messageBody contentTypeTag maybeDelaySeconds = do
    bodyOutcome <- buildQueueMessageBodyJSVal messageBody
    case bodyOutcome of
        Left information -> pure (Left information)
        Right messageJSVal -> do
            optionsJSVal <- jsEmptyObject
            contentTypeTagJSVal <- textToJSVal contentTypeTag
            jsSetOptionContentType optionsJSVal contentTypeTagJSVal
            for_ maybeDelaySeconds (jsSetOptionDelaySeconds optionsJSVal)
            envelopeJSVal <- jsQueueSendEnveloped producerJSVal messageJSVal optionsJSVal
            decodeMetricsEnvelope 0 envelopeJSVal

sendBatchViaFFI :: JSVal -> [(QueueBodyViaFFI, Text, Maybe Int)] -> IO (Either Text ())
sendBatchViaFFI producerJSVal messages = do
    fmap void (sendBatchResultViaFFI producerJSVal messages Nothing)

sendBatchResultViaFFI ::
    JSVal -> [(QueueBodyViaFFI, Text, Maybe Int)] -> Maybe Int -> IO (Either Text (Maybe QueueMetricsViaFFI))
sendBatchResultViaFFI producerJSVal messages maybeBatchDelaySeconds = do
    bodyOutcomes <- mapM (buildQueueMessageBodyJSVal . firstOfThree) messages
    case sequence bodyOutcomes of
        Left information -> pure (Left information)
        Right messageBodyJSVals -> sendBatchWithBodies messageBodyJSVals
  where
    firstOfThree (body, _, _) = body
    sendBatchWithBodies messageBodyJSVals = do
        messagesArrayJSVal <- jsEmptyArray
        for_ (zip messages messageBodyJSVals) $ \((_, contentTypeTag, maybeDelaySeconds), bodyJSVal) -> do
            entryJSVal <- jsEmptyObject
            jsSetMessageBody entryJSVal bodyJSVal
            contentTypeTagJSVal <- textToJSVal contentTypeTag
            jsSetOptionContentType entryJSVal contentTypeTagJSVal
            for_ maybeDelaySeconds (jsSetOptionDelaySeconds entryJSVal)
            jsArrayPush messagesArrayJSVal entryJSVal
        optionsJSVal <- jsEmptyObject
        for_ maybeBatchDelaySeconds (jsSetOptionDelaySeconds optionsJSVal)
        envelopeJSVal <- jsQueueSendBatchEnveloped producerJSVal messagesArrayJSVal optionsJSVal
        decodeMetricsEnvelope 0 envelopeJSVal

queueMetricsViaFFI :: JSVal -> IO (Either Text QueueMetricsViaFFI)
queueMetricsViaFFI producerJSVal = do
    result <- decodeMetricsEnvelope 2 =<< jsQueueMetricsEnveloped producerJSVal
    pure $ result >>= maybe (Left "missing queue metrics") Right

queueBatchQueueNameViaFFI :: JSVal -> IO Text
queueBatchQueueNameViaFFI batchJSVal = jsValToText =<< jsQueueBatchQueueField batchJSVal

queueBatchMessageJSValsViaFFI :: JSVal -> IO [JSVal]
queueBatchMessageJSValsViaFFI batchJSVal = do
    messagesArrayJSVal <- jsQueueBatchMessagesField batchJSVal
    messageCount <- jsArrayLength messagesArrayJSVal
    forM [0 .. messageCount - 1] (jsArrayIndex messagesArrayJSVal)

queueBatchAckAllViaFFI :: JSVal -> IO ()
queueBatchAckAllViaFFI = jsQueueBatchAckAll

queueBatchRetryAllViaFFI :: JSVal -> Maybe Int -> IO ()
queueBatchRetryAllViaFFI batchJSVal maybeDelaySeconds = do
    optionsJSVal <- buildQueueRetryOptionsJSVal maybeDelaySeconds
    jsQueueBatchRetryAll batchJSVal optionsJSVal

queueBatchMetricsViaFFI :: JSVal -> IO (Either Text (Maybe QueueMetricsViaFFI))
queueBatchMetricsViaFFI batch =
    decodeEnveloped decodeOptionalMetrics =<< jsNormalizeMetricsEnveloped batch 1

queueMessageIdViaFFI :: JSVal -> IO Text
queueMessageIdViaFFI messageJSVal = jsValToText =<< jsQueueMessageIdField messageJSVal

queueMessageTimestampMillisViaFFI :: JSVal -> IO Integer
queueMessageTimestampMillisViaFFI = fmap round . jsQueueMessageTimestampMillisField

queueMessageAttemptsViaFFI :: JSVal -> IO Int
queueMessageAttemptsViaFFI = jsQueueMessageAttemptsField

queueMessageBodyBytesViaFFI :: JSVal -> IO ByteString
queueMessageBodyBytesViaFFI messageJSVal = jsByteArrayToByteString =<< jsQueueMessageBodyBytes messageJSVal

queueMessageAckViaFFI :: JSVal -> IO ()
queueMessageAckViaFFI = jsQueueMessageAck

queueMessageRetryViaFFI :: JSVal -> Maybe Int -> IO ()
queueMessageRetryViaFFI messageJSVal maybeDelaySeconds = do
    optionsJSVal <- buildQueueRetryOptionsJSVal maybeDelaySeconds
    jsQueueMessageRetry messageJSVal optionsJSVal

-- All extension access and validation occurs in a safe, caught JS boundary.
-- Unsafe readers below only receive a private plain numeric snapshot.
decodeMetricsEnvelope :: Int -> JSVal -> IO (Either Text (Maybe QueueMetricsViaFFI))
decodeMetricsEnvelope mode envelope = do
    result <- decodeEnveloped pure envelope
    case result of
        Left reason -> pure (Left reason)
        Right value -> decodeEnveloped decodeOptionalMetrics =<< jsNormalizeMetricsEnveloped value mode

decodeOptionalMetrics :: JSVal -> IO (Maybe QueueMetricsViaFFI)
decodeOptionalMetrics value = do
    missing <- jsResponseIsVoid value
    if missing then pure Nothing else Just <$> decodeQueueMetrics value

decodeQueueMetrics :: JSVal -> IO QueueMetricsViaFFI
decodeQueueMetrics metricsJSVal = do
    backlogCount <- round <$> jsMetricsBacklogCount metricsJSVal
    backlogBytes <- round <$> jsMetricsBacklogBytes metricsJSVal
    timestampRaw <- jsMetricsOldestTimestampOrMissing metricsJSVal
    pure (backlogCount, backlogBytes, if timestampRaw < 0 then Nothing else Just (round timestampRaw))

buildQueueRetryOptionsJSVal :: Maybe Int -> IO JSVal
buildQueueRetryOptionsJSVal maybeDelaySeconds = do
    optionsJSVal <- jsEmptyObject
    for_ maybeDelaySeconds (jsSetOptionDelaySeconds optionsJSVal)
    pure optionsJSVal

foreign import javascript safe
    """
    (async () => {
      try {
        const value = await $1.send($2, $3);
        return {
          ok: true,
          value,
          message: ''
        };
      } catch (error) {
        return {
          ok: false,
          value: null,
          message: `${error}`
        };
      }
    })()
    """
    jsQueueSendEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
        (async () => {
          try {
            const value = await $1.sendBatch($2, $3);
            return {
              ok: true,
              value,
    message: ''
            };
          } catch (error) {
            return {
              ok: false,
              value: null,
              message: `${error}`
            };
          }
        })()
    """
    jsQueueSendBatchEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await (() => {
            if (typeof $1.metrics !== 'function') {
              throw new TypeError('Queue metrics are unavailable in this runtime');
            }
            return $1.metrics();
          })()
        };
      } catch (error) {
        return {
          ok: false,
          value: null,
          message: String(error)
        };
      }
    })()
    """
    jsQueueMetricsEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "$1 === undefined"
    jsResponseIsVoid :: JSVal -> IO Bool

foreign import javascript safe
    """
    (() => {
      try {
        const mode = $2;
        const input = $1;
        let metrics;
        if (mode === 0 && input === undefined) {
          return { ok: true, value: undefined };
        }
        if (mode === 2) {
          metrics = input;
        } else {
          const metadata = input.metadata;
          if (mode === 1 && metadata === undefined) {
            return { ok: true, value: undefined };
          }
          if (metadata === null || typeof metadata !== 'object') {
            throw new TypeError('invalid queue metadata');
          }
          metrics = metadata.metrics;
          if (mode === 1 && metrics === undefined) {
            return { ok: true, value: undefined };
          }
        }
        if (metrics === null || typeof metrics !== 'object') {
          throw new TypeError('invalid queue metrics');
        }
        const count = metrics.backlogCount;
        const bytes = metrics.backlogBytes;
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new TypeError('invalid queue backlogCount');
        }
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          throw new TypeError('invalid queue backlogBytes');
        }
        const timestamp = metrics.oldestMessageTimestamp;
        const millis = timestamp == null ? -1 : Date.prototype.getTime.call(timestamp);
        if (timestamp != null && (!Number.isSafeInteger(millis) || millis < 0)) {
          throw new TypeError('invalid queue oldestMessageTimestamp');
        }
        return { ok: true, value: { backlogCount: count, backlogBytes: bytes, timestampMillis: millis } };
      } catch (_) {
        return { ok: false, value: null, message: 'invalid queue metrics response' };
      }
    })()
    """
    jsNormalizeMetricsEnveloped :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "$1.backlogCount"
    jsMetricsBacklogCount :: JSVal -> IO Double

foreign import javascript unsafe "$1.backlogBytes"
    jsMetricsBacklogBytes :: JSVal -> IO Double

foreign import javascript unsafe "$1.timestampMillis"
    jsMetricsOldestTimestampOrMissing :: JSVal -> IO Double

foreign import javascript safe
    """
    (() => {
      try {
        return {
          ok: true,
          value: JSON.parse($1)
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()
    """
    jsJSONParseEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "({})"
    jsEmptyObject :: IO JSVal

foreign import javascript unsafe "[]"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push($2)"
    jsArrayPush :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe
    """
    (() => {
      const sourceArray = $1;
      if (!Array.isArray(sourceArray)) {
        throw new TypeError('the Queue message batch array is not a JS Array: ' + typeof sourceArray);
      }

      const elementCount = sourceArray.length;
      if (!Number.isSafeInteger(elementCount) || elementCount < 0 || elementCount > 2147483647) {
        throw new RangeError(
          'the Queue message batch array has a length no 32-bit Haskell Int can carry'
        );
      }

      return elementCount;
    })()
    """
    jsArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsArrayIndex :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "$1.body = $2"
    jsSetMessageBody :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.contentType = $2"
    jsSetOptionContentType :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.delaySeconds = $2"
    jsSetOptionDelaySeconds :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.queue"
    jsQueueBatchQueueField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.messages"
    jsQueueBatchMessagesField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.ackAll()"
    jsQueueBatchAckAll :: JSVal -> IO ()

foreign import javascript unsafe "$1.retryAll($2)"
    jsQueueBatchRetryAll :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.id"
    jsQueueMessageIdField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const timestampMillis = $1.timestamp?.getTime?.();

      if (!Number.isFinite(timestampMillis)) {
        throw new TypeError(
          'the Queue message timestamp is not a finite number: ' + typeof timestampMillis
        );
      }

      return timestampMillis;
    })()
    """
    jsQueueMessageTimestampMillisField :: JSVal -> IO Double

foreign import javascript unsafe
    """
    (() => {
      const attemptCount = $1.attempts;

      if (!Number.isSafeInteger(attemptCount) || attemptCount < 0 || attemptCount > 2147483647) {
        throw new TypeError(
          'the Queue message attempts field is not a non-negative 32-bit integer: ' + typeof attemptCount
        );
      }

      return attemptCount;
    })()
    """
    jsQueueMessageAttemptsField :: JSVal -> IO Int

foreign import javascript unsafe
    """
    (() => {
      const body = $1.body;

      if (typeof body === 'string') {
        return new TextEncoder().encode(body);
      }

      if (body instanceof ArrayBuffer) {
        return new Uint8Array(body);
      }

      if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      }

      return new TextEncoder().encode(JSON.stringify(body))
    })()
    """
    jsQueueMessageBodyBytes :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.ack()"
    jsQueueMessageAck :: JSVal -> IO ()

foreign import javascript unsafe "$1.retry($2)"
    jsQueueMessageRetry :: JSVal -> JSVal -> IO ()

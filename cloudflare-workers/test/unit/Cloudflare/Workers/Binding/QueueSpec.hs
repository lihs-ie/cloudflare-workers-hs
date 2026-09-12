module Cloudflare.Workers.Binding.QueueSpec (spec) where

import Cloudflare.Workers.Binding.Queue
import Cloudflare.Workers.Binding.DurableObject (DurableObjectValue (..))
import Cloudflare.Workers.HostTestKit (phantomJSVal)
import Control.Exception (try)
import Control.Monad (forM_)
import Data.ByteString qualified as Bytes
import Test.Syd

spec :: Spec
spec = describe "Queue producer contracts" $ do
    it "preserves the native rejection and distinguishes batch bytes from message size" $ do
        forM_ [("Invalid JSON", QueueInvalidBodyRejection), ("structured clone failed", QueueInvalidBodyRejection), ("DELAY invalid", QueueDelayOutOfRangeRejection), ("batch count exceeds limit", QueueBatchCountOutOfRangeRejection), ("messages exceed 100", QueueBatchCountOutOfRangeRejection), ("batch total size exceeds limit", QueueBatchBytesTooLargeRejction), ("batch bytes exceed limit", QueueBatchBytesTooLargeRejction), ("message exceeds 128 KiB", QueueBodyTooLargeRejection), ("body too large", QueueBodyTooLargeRejection), ("invalid size", QueueBodyTooLargeRejection), ("service unavailable", QueueOtherRejection)] $ \(message, kind) ->
            classifyQueueRejection message `shouldBe` QueueRejection kind message
    it "measures UTF-8 bytes and defers serialized representations to native validation" $ do
        map queueBodyByteLength bodies `shouldBe` [Just 3, Just 2, Nothing, Nothing, Nothing]
        map queueBodyContentType bodies `shouldBe` [QueueContentTypeText, QueueContentTypeBytes, QueueContentTypeJSON, QueueContentTypeV8, QueueContentTypeV8]
    it "keeps single and batch delay lower boundaries distinct" $ do
        map queueSendDelayIsValid delays `shouldBe` [True, False, True, True, True, False]
        map queueBatchDelayIsValid delays `shouldBe` [True, False, False, True, True, False]
    it "checks serialized size boundaries without negative lengths" $ do
        map queueMessageSerializedTotalSizeIsValid [-1,0,119999,120000] `shouldBe` [False,True,True,False]
        map queueBatchSerializedTotalSizeIsValid [-1,0,255999,256000,256001] `shouldBe` [False,True,True,True,False]
    it "validates message size before delay and accepts unknown serialized length" $ do
        validateQueueMessage (bytes 120000) (delay (-1)) `shouldBe` Left (QueueMessageTooLarge 120000)
        validateQueueMessage (bytes 119999) (delay (-1)) `shouldBe` Left (QueueDelayOutOfRange (-1))
        validateQueueMessage (QueueJSONBody "{}") (delay 86400) `shouldBe` Right ()
    it "validates empty and maximum batch counts" $ do
        validateQueueBatch [] queueBatchDefaultOptions `shouldBe` Left QueueBatchEmpty
        validateQueueBatch (replicate 100 entry) queueBatchDefaultOptions `shouldBe` Right ()
        validateQueueBatch (replicate 101 entry) queueBatchDefaultOptions `shouldBe` Left (QueueBatchTooManyMessages 101)
    it "reports the first failing message using zero-based indices" $ do
        validateQueueBatch [entry, (bytes 120000, queueSendDefaultOptions)] queueBatchDefaultOptions `shouldBe` Left (QueueBatchMessageTooLarge 1 120000)
        validateQueueBatch [entry, (bytes 1, delay 86401)] queueBatchDefaultOptions `shouldBe` Left (QueueBatchMessageDelayOutOfRange 1 86401)
    it "enforces aggregate bytes at the inclusive limit" $ do
        forM_ [255999,256000,256001] $ \size ->
            validateQueueBatch [(bytes 100000, queueSendDefaultOptions),(bytes 100000, queueSendDefaultOptions),(bytes (size - 200000), queueSendDefaultOptions)] queueBatchDefaultOptions
                `shouldBe` if size <= 256000 then Right () else Left (QueueBatchTotalTooLarge size)
    it "still checks delays when a batch contains an unknown serialized size" $ do
        validateQueueBatch [(QueueJSONBody "{}", delay (-1))] queueBatchDefaultOptions `shouldBe` Left (QueueBatchMessageDelayOutOfRange 0 (-1))
        validateQueueBatch [entry] (QueueBatchOptions (Just 0)) `shouldBe` Left (QueueBatchDelayOutOfRange 0)
        validateQueueBatch [entry] (QueueBatchOptions (Just 1)) `shouldBe` Right ()
    it "rejects invalid requests without reaching a native handle" $ do
        single <- try @QueueError (queueSendValue (QueueProducer phantomJSVal) (bytes 120000) queueSendDefaultOptions)
        single `shouldBe` Left (QueueValidationFailed (QueueMessageTooLarge 120000))
        batch <- try @QueueError (queueSendBatchWithOptions (QueueProducer phantomJSVal) [] queueBatchDefaultOptions)
        batch `shouldBe` Left (QueueValidationFailed QueueBatchEmpty)
    it "rejects negative metrics independently for count and bytes" $
        map queueMetricsIsValid [QueueMetrics 0 0 Nothing, QueueMetrics (-1) 0 Nothing, QueueMetrics 0 (-1) Nothing] `shouldBe` [True,False,False]
  where
    bytes count = QueueBytesBody (Bytes.replicate count 0)
    entry = (bytes 1, queueSendDefaultOptions)
    delay seconds = QueueSendOptions Nothing (Just seconds)
    delays = [Nothing, Just (-1), Just 0, Just 1, Just 86400, Just 86401]
    bodies = [QueueTextBody "あ", QueueBytesBody "ab", QueueJSONBody "{}", QueueV8Body "ab", QueueV8StructuredClone (DurableObjectValue phantomJSVal)]

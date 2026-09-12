module Cloudflare.Workers.Entrypoint.Queue.TypedSpec (spec) where
import Cloudflare.Workers.Entrypoint.Queue
import Cloudflare.Workers.Entrypoint.Queue.Typed
import Control.Exception (AsyncException(..), IOException, ErrorCall, SomeException, displayException, evaluate, throwIO, try)
import Data.Aeson (FromJSON(..), eitherDecode)
import Data.Maybe (isNothing)
import Data.IORef
import Support.Cloudflare.Workers.Queue (messages)
import Test.Syd

newtype LazyDecoded = LazyDecoded Int
instance FromJSON LazyDecoded where parseJSON _ = pure (error "lazy decoder")

spec :: Spec
spec = do
  it "acknowledges successful JSON and independently retries malformed JSON" $ do
    (batch, settlements) <- messages ["1", "bad", "2"]
    values <- newIORef []
    consumeJSONMessages (\_ value -> modifyIORef' values (<> [value :: Int])) batch
    readIORef values >>= (`shouldBe` [1,2])
    readIORef settlements >>= (`shouldBe` ["ack", "retry:Nothing", "ack"])
  it "retries a deferred unit result instead of acknowledging" $ do
    (batch, settlements) <- messages ["1"]
    consumeJSONMessages (\_ (_ :: Int) -> pure (error "lazy action")) batch
    readIORef settlements >>= (`shouldBe` ["retry:Nothing"])
  it "classifies deferred decoded values as decoding exceptions" $ do
    (batch, settlements) <- messages ["1"]
    consumeJSONMessagesWith (\_ failure -> case failure of
      QueueDecodeException _ -> pure AcknowledgeMessage
      _ -> fail "wrong failure phase") (\_ (_ :: LazyDecoded) -> fail "must not execute") batch
    readIORef settlements >>= (`shouldBe` ["ack"])
  it "lets the policy record processing failure and select delayed retry" $ do
    (batch, settlements) <- messages ["1"]
    consumeJSONMessagesWith (\_ failure -> case failure of
      QueueProcessingFailure cause -> do
        displayException cause `shouldBe` "user error (processing)"
        pure (RetryMessage (QueueRetryOptions (Just 7)))
      _ -> fail "wrong failure phase") (\_ (_ :: Int) -> fail "processing") batch
    readIORef settlements >>= (`shouldBe` ["retry:Just 7"])
  it "lets the application acknowledge malformed JSON" $ do
    (batch, settlements) <- messages ["bad"]
    consumeJSONMessagesWith (\_ failure -> case failure of
      QueueDecodeFailure _ -> pure AcknowledgeMessage
      _ -> fail "wrong failure phase") (\_ (_ :: Int) -> fail "must not execute") batch
    readIORef settlements >>= (`shouldBe` ["ack"])
  it "falls back to retry if a policy result or delay is deferred bottom" $ do
    mapM_ (\decision -> do
      (batch, settlements) <- messages ["bad"]
      consumeJSONMessagesWith (\_ _ -> pure decision) (\_ (_ :: Int) -> pure ()) batch
      readIORef settlements >>= (`shouldBe` ["retry:Nothing"]))
      [error "lazy policy", RetryMessage (QueueRetryOptions (Just (error "lazy delay")))]
  it "propagates cancellation without settling a message" $ do
    (batch, settlements) <- messages ["1"]
    outcome <- try @AsyncException (consumeJSONMessages (\_ (_ :: Int) -> throwIO ThreadKilled) batch)
    outcome `shouldBe` Left ThreadKilled
    readIORef settlements >>= (`shouldBe` [])
  it "propagates cancellation from the failure policy" $ do
    (batch, settlements) <- messages ["bad"]
    outcome <- try @AsyncException (consumeJSONMessagesWith (\_ _ -> throwIO UserInterrupt) (\_ (_ :: Int) -> pure ()) batch)
    outcome `shouldBe` Left UserInterrupt
    readIORef settlements >>= (`shouldBe` [])
  it "does not retry after acknowledgement throws" $ do
    (batch, settlements) <- messages ["1"]
    let failing = batch {queueBatchMessages = map (\message -> message {queueMessageAck = fail "ack failed"}) (queueBatchMessages batch)}
    outcome <- try @SomeException (consumeJSONMessages (\_ (_ :: Int) -> pure ()) failing)
    case outcome of
      Left cause -> displayException cause `shouldBe` "user error (ack failed)"
      Right () -> fail "ack failure swallowed"
    readIORef settlements >>= (`shouldBe` [])
  it "passes the original message metadata to the application" $ do
    (batch, settlements) <- messages ["42"]
    received <- newIORef []
    queueBatchQueueName batch `shouldBe` "fixture"
    queueBatchMetrics batch `shouldBe` Nothing
    consumeJSONMessages (\message value -> modifyIORef' received
      (<> [(queueMessageID message, queueMessageTimestamp message,
             queueMessageAttempts message, queueMessageBody message, value :: Int)])) batch
    readIORef received >>= (`shouldBe` [("fixture", 0, 1, "42", 42)])
    readIORef settlements >>= (`shouldBe` ["ack"])
  it "rejects batch-wide settlement in the per-message fixture" $ do
    (batch, settlements) <- messages []
    null (queueBatchMessages batch) `shouldBe` True
    acknowledged <- try @IOException (queueBatchAckAll batch)
    retried <- try @IOException (queueBatchRetryAll batch (QueueRetryOptions Nothing))
    either (Left . displayException) Right acknowledged
      `shouldBe` Left "user error (batch ack must not run)"
    either (Left . displayException) Right retried
      `shouldBe` Left "user error (batch retry must not run)"
    readIORef settlements >>= (`shouldBe` [])
  it "keeps the deferred decoder fixture consistent for lists and omitted fields" $ do
    case eitherDecode @[LazyDecoded] "[]" of
      Left message -> expectationFailure message
      Right values -> null values `shouldBe` True
    case eitherDecode @[LazyDecoded] "[1]" of
      Left message -> expectationFailure message
      Right values -> do
        length values `shouldBe` 1
        case values of
          [value] -> do
            outcome <- try @ErrorCall (evaluate value)
            either (takeWhile (/= '\n') . displayException) (const "unexpected success") outcome
              `shouldBe` "lazy decoder"
          _ -> expectationFailure "singleton JSON list changed length"
    isNothing (omittedField @LazyDecoded) `shouldBe` True

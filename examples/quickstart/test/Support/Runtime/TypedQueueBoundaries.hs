{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}

module Support.Runtime.TypedQueueBoundaries (typedQueueProbe) where

import Cloudflare.Workers.Entrypoint.Queue
import Cloudflare.Workers.Entrypoint.Queue.Typed
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (AsyncException (..), SomeException, displayException, fromException, throwIO, try)
import Control.Monad (when)
import Data.Aeson (FromJSON (..), eitherDecodeStrict', encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.IORef
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)

-- A successful parser with an unevaluated payload exercises the protected decode phase.
newtype LazyDecoded = LazyDecoded Int
instance FromJSON LazyDecoded where
    parseJSON _ = pure (error "lazy decoded value")

-- Settlement and action events are recorded independently, including attempted
-- settlements that throw. This distinguishes exactly-once attempts from success.
typedQueueProbe :: JSVal -> IO JSVal
typedQueueProbe commandValue = do
    command <- jsValToText commandValue
    events <- newIORef ([] :: [String])
    let record event = modifyIORef' events (<> [event])
        message index body =
            QueueMessage
                (Text.pack (show index))
                0
                1
                body
                (record ("ack:" <> show index) >> when (command == "ack-throws") (fail "ack failed"))
                ( \options -> do
                    record ("retry:" <> show index <> ":" <> show (queueRetryOptionsDelaySeconds options))
                    when (command == "retry-throws") $ fail "retry failed"
                )
        malformed = command `elem` ["malformed", "policy-throws", "policy-lazy", "options-lazy", "delay-lazy", "seconds-lazy", "policy-async", "retry-throws", "policy-ack", "delayed-retry"]
        firstBody = if malformed then "bad" else "1"
        batch =
            QueueBatch
                "typed-fixture"
                [message (1 :: Int) firstBody, message 2 "2"]
                Nothing
                (fail "batch ack must not run")
                (\_ -> fail "batch retry must not run")
        action messageValue (_ :: Int) = do
            record ("action:" <> Text.unpack (queueMessageID messageValue))
            if queueMessageID messageValue /= "1"
                then pure ()
                else case command of
                    "action-throws" -> fail "action failed"
                    "action-lazy" -> pure (error "lazy action result")
                    "action-async" -> throwIO ThreadKilled
                    _ -> pure ()
        policy _ failure = do
            when (command == "decode-diagnostic") $ record ("diagnostic:" <> show failure)
            record $ case failure of
                QueueDecodeFailure _ -> "failure:decode"
                QueueDecodeException _ -> "failure:decode-exception"
                QueueProcessingFailure _ -> "failure:processing"
            case command of
                "policy-throws" -> fail "policy failed"
                "policy-lazy" -> pure (error "lazy policy")
                "options-lazy" -> pure (RetryMessage (error "lazy retry options"))
                "delay-lazy" -> pure (RetryMessage (QueueRetryOptions (error "lazy delay")))
                "seconds-lazy" -> pure (RetryMessage (QueueRetryOptions (Just (error "lazy seconds"))))
                "policy-async" -> throwIO UserInterrupt
                "policy-ack" -> pure AcknowledgeMessage
                "delayed-retry" -> pure (RetryMessage (QueueRetryOptions (Just 7)))
                _ -> pure (RetryMessage (QueueRetryOptions Nothing))
        execute = case command of
            "schema-contract" -> do
                record $ case omittedField @LazyDecoded of Nothing -> "required"; Just _ -> "unexpected-default"
                record $ case eitherDecodeStrict' @[LazyDecoded] "[]" of Right values | null values -> "empty-list"; _ -> "invalid-empty-list"
                record $ case eitherDecodeStrict' @[LazyDecoded] "null" of Left _ -> "non-list-rejected"; Right _ -> "unexpected-list"
            "decode-diagnostic" -> consumeJSONMessagesWith policy (\_ (_ :: LazyDecoded) -> record "unexpected-action") batch
            "decode-lazy" -> consumeJSONMessagesWith policy (\_ (_ :: LazyDecoded) -> record "unexpected-action") batch
            "default-policy" -> consumeJSONMessages (\m (_ :: Int) -> if queueMessageID m == "1" then fail "default retry" else record "action:2") batch
            _ -> consumeJSONMessagesWith policy action batch
    result <- try @SomeException execute
    observed <- readIORef events
    let outcome = case result of
            Right () -> "ok"
            Left exception -> case fromException exception :: Maybe AsyncException of
                Just ThreadKilled -> "ThreadKilled"
                Just UserInterrupt -> "UserInterrupt"
                _ -> displayException exception
    textToJSVal $ Text.decodeUtf8 $ Lazy.toStrict $ encode $ object ["outcome" .= outcome, "events" .= observed]

{- | JSON queue consumption with explicit, per-message settlement. Payloads and
action results are evaluated to WHNF inside the protected processing phase.
-}
module Cloudflare.Workers.Entrypoint.Queue.Typed (
    QueueMessageFailure (..),
    QueueFailureDisposition (..),
    QueueFailurePolicy,
    consumeJSONMessages,
    consumeJSONMessagesWith,
    createJSONQueueHandler,
    createJSONQueueHandlerWith,
) where

import Cloudflare.Workers.Entrypoint.Queue
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv, BuildDOSEnv)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Control.Exception (SomeAsyncException, SomeException, evaluate, fromException, tryJust)
import Control.Monad (forM_, void)
import Data.Aeson (FromJSON, eitherDecodeStrict')
import Data.Either (fromRight)
import GHC.Wasm.Prim (JSVal)

data QueueMessageFailure
    = QueueDecodeFailure String
    | QueueDecodeException SomeException
    | QueueProcessingFailure SomeException
    deriving stock (Show)

data QueueFailureDisposition = RetryMessage QueueRetryOptions | AcknowledgeMessage
    deriving stock (Show, Eq)

type QueueFailurePolicy = QueueMessage -> QueueMessageFailure -> IO QueueFailureDisposition

-- Async cancellation must propagate without acknowledgement or retry.
trySynchronous :: IO a -> IO (Either SomeException a)
trySynchronous = tryJust $ \exception -> case fromException exception :: Maybe SomeAsyncException of
    Just _ -> Nothing
    Nothing -> Just exception

defaultRetry :: QueueFailureDisposition
defaultRetry = RetryMessage (QueueRetryOptions Nothing)

consumeJSONMessages :: (FromJSON a) => (QueueMessage -> a -> IO ()) -> QueueBatch -> IO ()
consumeJSONMessages = consumeJSONMessagesWith (\_ _ -> pure defaultRetry)

{- | Policy exceptions fall back to the default retry. Settlement failures escape
to the runtime; we never attempt a second settlement after ack/retry fails.
Action and policy callbacks must leave ack/retry to this helper: the original
QueueMessage is provided for metadata and compatibility, not manual settlement.
-}
consumeJSONMessagesWith :: (FromJSON a) => QueueFailurePolicy -> (QueueMessage -> a -> IO ()) -> QueueBatch -> IO ()
consumeJSONMessagesWith policy action batch = forM_ (queueBatchMessages batch) $ \message -> do
    decoded <- trySynchronous $ do
        result <- evaluate (eitherDecodeStrict' (queueMessageBody message))
        case result of
            Left reason -> evaluate (length reason) >> pure (Left reason)
            Right value -> Right <$> evaluate value
    outcome <- case decoded of
        Left exception -> pure (Left (QueueDecodeException exception))
        Right (Left reason) -> pure (Left (QueueDecodeFailure reason))
        Right (Right value) -> do
            processed <- trySynchronous (action message value >>= evaluate)
            pure (either (Left . QueueProcessingFailure) (const (Right ())) processed)
    disposition <- case outcome of
        Right () -> pure AcknowledgeMessage
        Left failure -> do
            chosen <- trySynchronous $ policy message failure >>= forceDisposition
            pure (fromRight defaultRetry chosen)
    case disposition of
        AcknowledgeMessage -> queueMessageAck message
        RetryMessage options -> queueMessageRetry message options
  where
    forceDisposition choice = do
        value <- evaluate choice
        case value of
            AcknowledgeMessage -> pure value
            RetryMessage options -> do
                delay <- evaluate (queueRetryOptionsDelaySeconds options)
                case delay of { Nothing -> pure (); Just seconds -> void (evaluate seconds) }
                pure value

createJSONQueueHandler ::
    (FromJSON a, BuildBindingEnv bindings, BuildDOSEnv dos) =>
    (QueueMessage -> a -> BindingEnv kvs dos bindings -> WorkersExecutionContext -> IO ()) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createJSONQueueHandler = createJSONQueueHandlerWith (\_ _ _ _ -> pure defaultRetry)

createJSONQueueHandlerWith ::
    (FromJSON a, BuildBindingEnv bindings, BuildDOSEnv dos) =>
    (QueueMessage -> QueueMessageFailure -> BindingEnv kvs dos bindings -> WorkersExecutionContext -> IO QueueFailureDisposition) ->
    (QueueMessage -> a -> BindingEnv kvs dos bindings -> WorkersExecutionContext -> IO ()) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createJSONQueueHandlerWith policy action = createQueueHandler $ \batch env context ->
    consumeJSONMessagesWith
        (\message failure -> policy message failure env context)
        (\message value -> action message value env context)
        batch

{- | JSON-typed Workflows bindings and durable steps. Side effects belong inside
named steps and must use destination-side idempotency across retry attempts.
Values use JSON (not arbitrary structured-clone objects). Integers must remain
within +/-9007199254740991; native JavaScript numbers cannot preserve larger
integers. Encode those as strings. Native step-result size limits still apply.
Timeout cancellation is cooperative: user callbacks must remain interruptible
and must not enter uninterruptibleMask around indefinitely blocking work.
-}
module Cloudflare.Workers.Binding.Workflow (
    Workflow (..),
    WorkflowIdentifier (..),
    WorkflowInstance,
    workflowInstanceIdentifier,
    WorkflowState (..),
    WorkflowStatus (..),
    WorkflowFailure (..),
    WorkflowError (..),
    WorkflowStep,
    workflowStepFromJSVal,
    WorkflowStepContext (..),
    WorkflowDuration (..),
    WorkflowBackoff (..),
    WorkflowStepOptions (..),
    defaultWorkflowStepOptions,
    WorkflowNonRetryableError (..),
    WorkflowReceivedEvent (..),
    workflowCreate,
    workflowGet,
    workflowStatus,
    workflowSendEvent,
    workflowPause,
    workflowResume,
    workflowRestart,
    workflowTerminate,
    workflowStepDo,
    workflowSleep,
    workflowSleepUntil,
    workflowWaitForEvent,
) where

import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Internal.FFI.Workflow
import Control.Concurrent (forkIOWithUnmask, killThread)
import Control.Exception (Exception, SomeAsyncException, SomeException, bracket, displayException, fromException, mask_, throwIO, try)
import Control.Monad (when, (>=>))
import Data.Aeson
import Data.ByteString.Lazy qualified as Lazy
import Data.IORef (atomicModifyIORef', newIORef, readIORef)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)

newtype Workflow params = Workflow JSVal
newtype WorkflowIdentifier = WorkflowIdentifier {unWorkflowIdentifier :: Text}
    deriving stock (Show, Eq, Ord)
data WorkflowInstance = WorkflowInstance
    { workflowInstanceIdentifier :: WorkflowIdentifier
    , workflowInstanceValue :: JSVal
    }
newtype WorkflowStep = WorkflowStep JSVal
newtype WorkflowDuration = WorkflowMilliseconds Integer deriving stock (Show, Eq)
data WorkflowBackoff = WorkflowConstant | WorkflowLinear | WorkflowExponential deriving stock (Show, Eq)
data WorkflowStepOptions = WorkflowStepOptions
    { workflowRetryLimit :: Int
    , workflowRetryDelay :: WorkflowDuration
    , workflowRetryBackoff :: WorkflowBackoff
    , workflowStepTimeout :: WorkflowDuration
    }
    deriving stock (Show, Eq)
defaultWorkflowStepOptions :: WorkflowStepOptions
defaultWorkflowStepOptions = WorkflowStepOptions 5 (WorkflowMilliseconds 1000) WorkflowExponential (WorkflowMilliseconds 60000)
data WorkflowStepContext = WorkflowStepContext
    { workflowStepName :: Text
    , workflowStepCount :: Int
    , workflowStepAttempt :: Int
    }
    deriving stock (Show, Eq)
instance FromJSON WorkflowStepContext where
    parseJSON = withObject "WorkflowStepContext" $ \o -> do
        step <- o .: "step"
        WorkflowStepContext <$> step .: "name" <*> step .: "count" <*> o .: "attempt"
data WorkflowState
    = WorkflowQueued
    | WorkflowRunning
    | WorkflowPaused
    | WorkflowErrored
    | WorkflowTerminated
    | WorkflowComplete
    | WorkflowWaiting
    | WorkflowWaitingForPause
    | WorkflowUnknown Text
    deriving stock (Show, Eq)
data WorkflowFailure = WorkflowFailure {workflowFailureName :: Text, workflowFailureMessage :: Text}
    deriving stock (Show, Eq)
instance FromJSON WorkflowFailure where
    parseJSON = withObject "WorkflowFailure" $ \o -> WorkflowFailure <$> o .: "name" <*> o .: "message"
data WorkflowStatus output = WorkflowStatus
    { workflowState :: WorkflowState
    , workflowOutput :: Maybe output
    , workflowFailure :: Maybe WorkflowFailure
    }
    deriving stock (Show, Eq)
instance (FromJSON output) => FromJSON (WorkflowStatus output) where
    parseJSON = withObject "WorkflowStatus" $ \o -> do
        state <- o .: "status"
        WorkflowStatus
            ( case state of
                "queued" -> WorkflowQueued
                "running" -> WorkflowRunning
                "paused" -> WorkflowPaused
                "errored" -> WorkflowErrored
                "terminated" -> WorkflowTerminated
                "complete" -> WorkflowComplete
                "waiting" -> WorkflowWaiting
                "waitingForPause" -> WorkflowWaitingForPause
                other -> WorkflowUnknown other
            )
            <$> o .:? "output"
            <*> o .:? "error"
data WorkflowReceivedEvent payload = WorkflowReceivedEvent
    { workflowReceivedPayload :: payload
    , workflowReceivedType :: Text
    , workflowReceivedTimestamp :: Text
    }
    deriving stock (Show, Eq)
instance (FromJSON payload) => FromJSON (WorkflowReceivedEvent payload) where
    parseJSON = withObject "WorkflowReceivedEvent" $ \o ->
        WorkflowReceivedEvent <$> o .: "payload" <*> o .: "type" <*> o .: "timestamp"
data WorkflowError = WorkflowError {workflowErrorOperation :: Text, workflowErrorMessage :: Text}
    deriving stock (Show, Eq)
instance Exception WorkflowError
newtype WorkflowNonRetryableError = WorkflowNonRetryableError Text deriving stock (Show, Eq)
instance Exception WorkflowNonRetryableError

encodeJSONText :: (ToJSON a) => a -> Text
encodeJSONText = Text.decodeUtf8 . Lazy.toStrict . encode
parseJSONText :: (FromJSON a) => Text -> Text -> IO a
parseJSONText operation input = either (throwIO . WorkflowError operation . Text.pack) pure (eitherDecodeStrict' (Text.encodeUtf8 input))
unwrap :: Text -> (JSVal -> IO a) -> JSVal -> IO a
unwrap operation decoder envelope = either (throwIO . WorkflowError operation) pure =<< decodeEnveloped decoder envelope
unwrapStep :: Text -> (JSVal -> IO a) -> JSVal -> IO a
unwrapStep operation decoder envelope = do
    outcome <- decodeEnveloped decoder envelope
    case outcome of
        Right value -> pure value
        Left message -> do
            native <- jsFailureNativeError envelope
            throwIO (WorkflowNativeError (operation <> ": " <> message) native)
instanceFromJSVal :: JSVal -> IO WorkflowInstance
instanceFromJSVal raw = do
    identifier <- WorkflowIdentifier <$> (jsInstanceIdentifier raw >>= jsValToText)
    pure (WorkflowInstance identifier raw)
workflowCreate :: (ToJSON params) => Workflow params -> Maybe WorkflowIdentifier -> params -> IO WorkflowInstance
workflowCreate (Workflow binding) identifier params = do
    options <- textToJSVal (encodeJSONText (object (["params" .= params] <> maybe [] (\(WorkflowIdentifier value) -> ["id" .= value]) identifier)))
    jsWorkflowCreate binding options >>= unwrap "create" instanceFromJSVal
workflowGet :: Workflow params -> WorkflowIdentifier -> IO WorkflowInstance
workflowGet (Workflow binding) (WorkflowIdentifier identifier) = do
    raw <- textToJSVal identifier
    jsWorkflowGet binding raw >>= unwrap "get" instanceFromJSVal

{- | Read the observed platform state. An internal error can be transient just
after control succeeds; retry status reads for at most two additional seconds.
Other errors and decode failures are preserved. Control calls are never replayed.
-}
workflowStatus :: (FromJSON output) => WorkflowInstance -> IO (WorkflowStatus output)
workflowStatus instance' = jsWorkflowStatus (workflowInstanceValue instance') >>= unwrap "status" (jsValToText >=> parseJSONText "status")

workflowSendEvent :: (ToJSON payload) => WorkflowInstance -> Text -> payload -> IO ()
workflowSendEvent instance' eventType payload = do
    options <- textToJSVal (encodeJSONText (object ["type" .= eventType, "payload" .= payload]))
    jsWorkflowSendEvent (workflowInstanceValue instance') options >>= unwrap "sendEvent" (const (pure ()))
controlInstance :: Text -> WorkflowInstance -> IO ()
controlInstance operation instance' = do
    method <- textToJSVal operation
    jsWorkflowControl (workflowInstanceValue instance') method >>= unwrap operation (const (pure ()))
workflowPause, workflowResume, workflowRestart, workflowTerminate :: WorkflowInstance -> IO ()
workflowPause = controlInstance "pause"
workflowResume = controlInstance "resume"
workflowRestart = controlInstance "restart"
workflowTerminate = controlInstance "terminate"

{- | The second argument must be NonRetryableError imported from
cloudflare:workflows. It is scoped to this handle, never installed globally.
-}
workflowStepFromJSVal :: JSVal -> JSVal -> IO WorkflowStep
workflowStepFromJSVal raw errorClass = WorkflowStep <$> jsWorkflowStep raw errorClass

checkedDuration :: WorkflowDuration -> IO Integer
checkedDuration (WorkflowMilliseconds value)
    | value < 0 || value > 9007199254740991 = throwIO (WorkflowError "duration" "duration is outside the JavaScript safe integer range")
    | otherwise = pure value
validateStepName :: Text -> IO ()
validateStepName name = when (Text.null name || Text.length name > 256) (throwIO (WorkflowError "step" "step name must contain 1 to 256 characters"))

{- | Keep the mailbox alive until the entire step.do settles, including retry
callbacks. On cancellation reject all pending JS promises before releasing it.
-}
workflowStepDo :: (ToJSON a, FromJSON a) => WorkflowStep -> Text -> WorkflowStepOptions -> (WorkflowStepContext -> IO a) -> IO a
workflowStepDo (WorkflowStep step) name options action = do
    validateStepName name
    when (workflowRetryLimit options < 0) (throwIO (WorkflowError "step.do" "negative retry limit"))
    delay <- checkedDuration (workflowRetryDelay options)
    timeout <- checkedDuration (workflowStepTimeout options)
    config <-
        textToJSVal
            ( encodeJSONText
                ( object
                    [ "retries" .= object ["limit" .= workflowRetryLimit options, "delay" .= delay, "backoff" .= backoff]
                    , "timeout" .= timeout
                    ]
                )
            )
    rawName <- textToJSVal name
    bracket
        (do mailbox <- jsStartStep step rawName config; children <- newIORef []; pure (mailbox, children))
        (\(mailbox, children) -> jsCloseStep mailbox >> (readIORef children >>= mapM_ killThread))
        dispatch
  where
    backoff :: Text
    backoff = case workflowRetryBackoff options of WorkflowConstant -> "constant"; WorkflowLinear -> "linear"; WorkflowExponential -> "exponential"
    dispatch state@(mailbox, children) = do
        message <- jsNextStepMessage mailbox
        isCall <- jsIsStepCall message
        value <- jsMessageValue message
        if not isCall
            then do
                nonRetryable <- jsFailureNonRetryable value
                if nonRetryable
                    then do
                        failure <- jsFailureMessage value >>= jsValToText
                        throwIO (WorkflowNonRetryableError failure)
                    else unwrapStep "step.do" (jsValToText >=> parseJSONText "step.do") value
            else do
                -- The native timeout may have superseded a prior callback. Cancel
                -- it before starting the retry; still keep all JS promises scoped
                -- until the outer do settles. Never block the dispatcher on user IO.
                mask_ $ do
                    previous <- readIORef children
                    mapM_ killThread previous
                    child <- forkIOWithUnmask $ \unmask -> do
                        outcome <- try @SomeException $ unmask $ do
                            context <- jsStepContext value >>= jsValToText >>= parseJSONText "step.context"
                            result <- action context
                            textToJSVal (encodeJSONText result)
                        case outcome of
                            Right result -> jsResolveStepCall mailbox value True False result
                            Left exception -> case fromException @SomeAsyncException exception of
                                Just _ -> pure () -- outer scope/next attempt releases its promise
                                Nothing -> do
                                    let nonRetryable = case fromException @WorkflowNonRetryableError exception of Just _ -> True; Nothing -> False
                                    reason <- textToJSVal (Text.pack (displayException exception))
                                    jsResolveStepCall mailbox value False nonRetryable reason
                    atomicModifyIORef' children (\threads -> (child : threads, ()))
                dispatch state

workflowSleep :: WorkflowStep -> Text -> WorkflowDuration -> IO ()
workflowSleep (WorkflowStep step) name duration = do
    validateStepName name
    milliseconds <- checkedDuration duration
    rawName <- textToJSVal name
    jsWorkflowSleep step rawName (fromInteger milliseconds) >>= unwrapStep "sleep" (const (pure ()))
workflowSleepUntil :: WorkflowStep -> Text -> Integer -> IO ()
workflowSleepUntil (WorkflowStep step) name timestamp = do
    validateStepName name
    milliseconds <- checkedDuration (WorkflowMilliseconds timestamp)
    rawName <- textToJSVal name
    jsWorkflowSleepUntil step rawName (fromInteger milliseconds) >>= unwrapStep "sleepUntil" (const (pure ()))
workflowWaitForEvent :: (FromJSON payload) => WorkflowStep -> Text -> Text -> WorkflowDuration -> IO (WorkflowReceivedEvent payload)
workflowWaitForEvent (WorkflowStep step) name eventType duration = do
    validateStepName name
    milliseconds <- checkedDuration duration
    rawName <- textToJSVal name
    options <- textToJSVal (encodeJSONText (object ["type" .= eventType, "timeout" .= milliseconds]))
    jsWorkflowWaitForEvent step rawName options >>= unwrapStep "waitForEvent" (jsValToText >=> parseJSONText "waitForEvent")

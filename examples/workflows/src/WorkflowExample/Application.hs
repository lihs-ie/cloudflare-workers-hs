module WorkflowExample.Application (server, runApproval) where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query qualified as Query
import Cloudflare.Workers.Binding.Workflow
import Cloudflare.Workers.Entrypoint.Workflow
import Control.Exception (throwIO, try)
import Control.Monad (void, when)
import Control.Monad.Except (throwError)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Time (getCurrentTime)
import Data.Time.Clock.POSIX (utcTimeToPOSIXSeconds)
import Servant.Cloudflare.Workers.Error (err400, err500, withDetail)
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Server.Internal ()
import WorkflowExample.API
import WorkflowExample.Domain

server :: Workflow ApprovalRequest -> D1 -> Server API env
server workflow database =
    Routes
        { health = pure (object ["status" .= ("ok" :: Text)])
        , create = \input -> do
            when
                (Text.null (identifier input) || Text.null (message (parameters input)) || behavior (parameters input) `notElem` ["normal", "retry", "fail"])
                (throwError (withDetail "identifier/message required; behavior must be normal, retry or fail" err400))
            workflowResult $ do
                instance' <- workflowCreate workflow (Just (WorkflowIdentifier (identifier input))) (parameters input)
                statusValue instance'
        , createGenerated = \input -> do
            when
                (Text.null (message input) || behavior input `notElem` ["normal", "retry", "fail"])
                (throwError (withDetail "message required; behavior must be normal, retry or fail" err400))
            workflowResult $ workflowCreate workflow Nothing input >>= statusValue
        , status = \identifier' -> workflowResult $ workflowGet workflow (WorkflowIdentifier identifier') >>= statusValue
        , approve = \identifier' approval -> workflowResult $ do
            instance' <- workflowGet workflow (WorkflowIdentifier identifier')
            workflowSendEvent instance' "approval" approval
            pure (object ["accepted" .= True])
        , control = \identifier' operation -> case lookup
            operation
            [("pause", workflowPause), ("resume", workflowResume), ("restart", workflowRestart), ("terminate", workflowTerminate)] of
            Nothing -> throwError (withDetail "unknown Workflow control operation" err400)
            Just action -> workflowResult $ do
                instance' <- workflowGet workflow (WorkflowIdentifier identifier')
                action instance'
                pure (object ["accepted" .= True, "identifier" .= identifier', "operation" .= operation])
        , audit = liftIO . auditValue database
        }
  where
    workflowResult action = do
        outcome <- liftIO (try @WorkflowError action)
        either (\failure -> throwError (withDetail (workflowErrorOperation failure <> ": " <> workflowErrorMessage failure) err500)) pure outcome

statusValue :: WorkflowInstance -> IO Value
statusValue instance' = do
    status' <- workflowStatus @Value instance'
    pure
        ( object
            [ "identifier" .= unWorkflowIdentifier (workflowInstanceIdentifier instance')
            , "state" .= show (workflowState status')
            , "output" .= workflowOutput status'
            , "error" .= fmap workflowFailureMessage (workflowFailure status')
            ]
        )

recordAttempt :: D1 -> Text -> Text -> Int -> IO ()
recordAttempt database instance' stepName attempt =
    void $
        Query.d1Execute
            database
            ( Query.D1Statement
                "INSERT INTO attempts(instance, step, attempt) VALUES (?, ?, ?)"
                [D1Text instance', D1Text stepName, D1Integer (toInteger attempt)]
            )

-- Business decisions and every durable step live in Haskell. Stable names and
-- an instance-scoped key make replay and destination-side deduplication explicit.
runApproval :: D1 -> WorkflowEvent ApprovalRequest -> WorkflowStep -> IO Value
runApproval database event step = do
    let instance' = unWorkflowIdentifier (workflowEventInstance event)
        input = workflowEventPayload event
        options =
            defaultWorkflowStepOptions
                { workflowRetryLimit = 2
                , workflowRetryDelay = WorkflowMilliseconds 100
                , workflowStepTimeout = WorkflowMilliseconds 10000
                }
    prepared <- workflowStepDo step "prepare-request" options $ \context -> do
        recordAttempt database instance' "prepare-request" (workflowStepAttempt context)
        pure (message input)
    workflowSleep step "short-cooling-period" (WorkflowMilliseconds 100)
    workflowStepDo step "await-approval" options $ \context ->
        recordAttempt database instance' "await-approval" (workflowStepAttempt context)
    incoming <- workflowWaitForEvent @Approval step "wait-for-approval" "approval" (WorkflowMilliseconds 60000)
    -- Approval always precedes scheduling. Past timestamps need no timer.
    case executeAt input of
        Nothing -> pure ()
        Just target -> do
            now <- getCurrentTime
            when (target > now) $ do
                workflowStepDo step "scheduled-execution" options $ \context ->
                    recordAttempt database instance' "scheduled-execution" (workflowStepAttempt context)
                workflowSleepUntil step "wait-until-execution" (ceiling (utcTimeToPOSIXSeconds target * 1000))
    committed <- workflowStepDo step "commit-request" options $ \context -> do
        recordAttempt database instance' "commit-request" (workflowStepAttempt context)
        when (behavior input == "fail") (throwIO (WorkflowNonRetryableError "request rejected permanently"))
        -- Simulate a transient upstream failure AFTER a durable side effect.
        -- A unique destination key protects the write when this callback retries.
        void $
            Query.d1Execute
                database
                ( Query.D1Statement
                    "INSERT INTO effects(instance, message) VALUES (?, ?) ON CONFLICT(instance) DO NOTHING"
                    [D1Text instance', D1Text prepared]
                )
        when (behavior input == "retry" && workflowStepAttempt context < 3) (fail "temporary response loss after committed write")
        pure prepared
    workflowStepDo step "finish-request" options $ \context -> do
        recordAttempt database instance' "finish-request" (workflowStepAttempt context)
        pure (object ["message" .= committed, "approved" .= approved (workflowReceivedPayload incoming)])

auditValue :: D1 -> Text -> IO Value
auditValue database instance' = do
    attempts <-
        Query.d1Query
            database
            (Query.D1Statement "SELECT step, attempt FROM attempts WHERE instance = ? ORDER BY sequence" [D1Text instance'])
            ((,) <$> Query.d1Column "step" Query.d1Text <*> Query.d1Column "attempt" Query.d1Integer)
    effects <-
        Query.d1QueryFirst
            database
            (Query.D1Statement "SELECT count(*) AS total FROM effects WHERE instance = ?" [D1Text instance'])
            (Query.d1Column "total" Query.d1Integer)
    -- Preserve the public audit response while rejecting malformed database rows.
    pure
        ( object
            [ "attempts" .= map (\(step, attempt) -> object ["step" .= step, "attempt" .= attempt, "total" .= Null]) attempts
            , "effects" .= maybe Null (\total -> object ["step" .= Null, "attempt" .= Null, "total" .= total]) effects
            ]
        )

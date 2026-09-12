module Support.WorkflowFixture (runFixture) where
import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.Workflow
import Cloudflare.Workers.Entrypoint.Workflow
import Control.Concurrent.MVar (newEmptyMVar, takeMVar)
import Control.Exception (finally)
import Control.Monad (void, when)
import Data.Aeson (Value, object, (.=))
import Data.Text (Text)
import WorkflowExample.Domain

runFixture :: D1 -> WorkflowEvent ApprovalRequest -> WorkflowStep -> IO Value
runFixture database event step = case behavior (workflowEventPayload event) of
    "timeout" -> workflowStepDo step "hung-callback" options $ \context ->
        (record "hung-callback" (workflowStepAttempt context) >> newEmptyMVar >>= takeMVar)
            `finally` record "cancelled-callback" (workflowStepAttempt context)
    "event-timeout" -> waitForApproval (WorkflowMilliseconds 300)
    "event-payload" -> waitForApproval (WorkflowMilliseconds 10000)
    "backoff-constant" -> retryWith WorkflowConstant
    "backoff-linear" -> retryWith WorkflowLinear
    "backoff-exponential" -> retryWith WorkflowExponential
    "unsafe-integer" -> workflowStepDo step "unsafe-integer" options (const (pure (object ["number" .= (9007199254740993 :: Integer)])))
    "lazy-output" -> do
        _ <- workflowStepDo step "before-lazy-output" options (const (pure True))
        pure (object ["lazy" .= (error "lazy workflow output failure" :: Text)])
    _ -> workflowStepDo step "lazy-step" options{workflowRetryLimit=0} $ \_ ->
        pure (object ["lazy" .= (error "lazy step output failure" :: Text)])
  where
    options = defaultWorkflowStepOptions {workflowRetryLimit=1, workflowRetryDelay=WorkflowMilliseconds 50, workflowStepTimeout=WorkflowMilliseconds 200}
    instance' = unWorkflowIdentifier (workflowEventInstance event)
    record name attempt = void $ do
        statement <- d1Prepare database "INSERT INTO attempts(instance, step, attempt) VALUES (?, ?, ?)"
        bound <- d1Bind statement [D1Text instance', D1Text name, D1Integer (toInteger attempt)]
        d1Run bound

    waitForApproval duration = do
        workflowStepDo step "fixture-await-event" options (const (record "fixture-await-event" 1))
        incoming <- workflowWaitForEvent @Approval step "fixture-event" "approval" duration
        workflowStepDo step "fixture-event-received" options $ \context -> do
            record "fixture-event-received" (workflowStepAttempt context)
            pure (object ["approved" .= approved (workflowReceivedPayload incoming), "type" .= workflowReceivedType incoming, "timestamp" .= workflowReceivedTimestamp incoming])
    retryWith backoff = workflowStepDo step "fixture-backoff" options{workflowRetryBackoff=backoff} $ \context -> do
        record "fixture-backoff" (workflowStepAttempt context)
        when (workflowStepAttempt context == 1) (fail "transient fixture failure")
        pure (object ["name" .= workflowStepName context, "count" .= workflowStepCount context, "attempt" .= workflowStepAttempt context])

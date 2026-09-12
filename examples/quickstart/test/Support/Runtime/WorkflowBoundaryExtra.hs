module Support.Runtime.WorkflowBoundaryExtra (workflowBoundaryExtraProbe) where

import Cloudflare.Workers.Binding.Workflow
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (SomeException, displayException, try)
import Data.Aeson
import Data.List (sort)
import Data.Aeson.Types (parseEither)
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)

-- The fixture observes typed results, rather than merely executing IO actions.
workflowBoundaryExtraProbe :: JSVal -> JSVal -> JSVal -> IO JSVal
workflowBoundaryExtraProbe raw errorClass config = do
    encoded <- jsValToText config
    result <- try @SomeException $ do
        value <- either fail pure (eitherDecodeStrict' (Text.encodeUtf8 encoded))
        (operation, name, duration, retry, backoff) <- either fail pure $ parseEither (withObject "config" $ \o ->
            (,,,,) <$> o .: "operation" <*> o .:? "name" .!= "boundary"
                   <*> o .:? "duration" .!= 0 <*> o .:? "retry" .!= 0
                   <*> o .:? "backoff" .!= ("constant" :: Text)) value
        step <- workflowStepFromJSVal raw errorClass
        let options = defaultWorkflowStepOptions
                { workflowRetryLimit = retry
                , workflowRetryDelay = WorkflowMilliseconds duration
                , workflowStepTimeout = WorkflowMilliseconds duration
                , workflowRetryBackoff = case backoff of
                    "linear" -> WorkflowLinear
                    "exponential" -> WorkflowExponential
                    _ -> WorkflowConstant
                }
            observeCompletion action = action >> pure (Bool True)
        case (operation :: Text) of
            "send-event" -> do
                instance' <- workflowGet (Workflow raw :: Workflow Value) (WorkflowIdentifier "boundary")
                sent <- try @WorkflowError (workflowSendEvent instance' "ready" (7 :: Int))
                pure $ either (\failure -> object ["operation" .= workflowErrorOperation failure, "message" .= workflowErrorMessage failure]) (const (Bool True)) sent
            "failure-diagnostics" -> do
                let malformed = eitherDecode "[]" :: Either String WorkflowFailure
                    decoded = eitherDecode "{\"name\":\"ValidationError\",\"message\":\"invalid input\"}" :: Either String WorkflowFailure
                failure <- either fail pure decoded
                diagnostic <- case malformed of
                    Left message -> pure message
                    Right _ -> fail "Expected malformed failure rejection"
                pure (object ["diagnostic" .= diagnostic, "name" .= workflowFailureName failure,
                    "message" .= workflowFailureMessage failure,
                    "matches" .= (failure == WorkflowFailure "ValidationError" "invalid input"),
                    "different" .= (failure /= WorkflowFailure "ValidationError" "changed"),
                    "rendered" .= show failure])
            "identifier-order" -> do
                let identifiers = map WorkflowIdentifier ["job-c", "job-a", "job-b"]
                    ordered = sort identifiers
                pure (object ["ordered" .= map unWorkflowIdentifier ordered,
                    "first" .= unWorkflowIdentifier (minimum identifiers),
                    "last" .= unWorkflowIdentifier (maximum identifiers),
                    "diagnostic" .= show ordered])
            "defaults" -> do
                output <- workflowStepDo @Int step name defaultWorkflowStepOptions (const (pure 1))
                pure (toJSON output)
            "lifecycle" -> do
                instance' <- workflowCreate (Workflow raw :: Workflow Value) (Just (WorkflowIdentifier "boundary")) (object ["input" .= (7 :: Int)])
                workflowSendEvent instance' "ready" (7 :: Int)
                mapM_ (\action -> action instance') [workflowPause, workflowResume, workflowRestart, workflowTerminate]
                pure (toJSON (unWorkflowIdentifier (workflowInstanceIdentifier instance')))
            "do" -> do
                output <- workflowStepDo @Int step name options $ \context ->
                    pure (workflowStepCount context + workflowStepAttempt context + length (show (workflowStepName context)))
                pure (toJSON output)
            "sleep" -> observeCompletion (workflowSleep step name (WorkflowMilliseconds duration))
            "sleepUntil" -> observeCompletion (workflowSleepUntil step name duration)
            "event" -> do
                event <- workflowWaitForEvent @Int step name "ready" (WorkflowMilliseconds duration)
                pure (object ["payload" .= workflowReceivedPayload event, "type" .= workflowReceivedType event, "timestamp" .= workflowReceivedTimestamp event])
            "status" -> do
                instance' <- workflowGet (Workflow raw :: Workflow Value) (WorkflowIdentifier "boundary")
                status <- workflowStatus @Int instance'
                pure (object ["state" .= show (workflowState status), "output" .= workflowOutput status, "failure" .= fmap show (workflowFailure status)])
            _ -> fail "Unknown workflow boundary operation"
    textToJSVal $ Text.decodeUtf8 $ Lazy.toStrict $ encode $
        either (\exception -> object ["ok" .= False, "message" .= displayException exception])
               (\value -> object ["ok" .= True, "value" .= value]) result

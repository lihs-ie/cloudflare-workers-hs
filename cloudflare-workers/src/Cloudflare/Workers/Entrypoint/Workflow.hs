-- | Adapter for a thin TypeScript WorkflowEntrypoint. The adapter returns an
-- explicit outcome: the TS entrypoint must return outcome.value on success and
-- throw outcome.nativeError unchanged when present; otherwise throw
-- Error/NonRetryableError on failure. This keeps Haskell exceptions from
-- escaping the WASM runtime and preserves native non-retryable classification.
module Cloudflare.Workers.Entrypoint.Workflow
    ( WorkflowEvent (..), WorkflowHandler, createWorkflowHandler ) where

import Cloudflare.Workers.Binding.Workflow (WorkflowIdentifier (..), WorkflowStep, WorkflowNonRetryableError, workflowStepFromJSVal)
import Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv, BuildDOSEnv)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Internal.FFI.Workflow (jsWorkflowEvent, jsWorkflowJSONValue, WorkflowNativeError (..), jsWorkflowNativeFailure)
import Control.Exception (SomeException, SomeAsyncException, displayException, fromException, throwIO, try)
import Data.Aeson
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Encoding
import GHC.Wasm.Prim (JSVal)

data WorkflowEvent params = WorkflowEvent
    { workflowEventPayload :: params
    , workflowEventInstance :: WorkflowIdentifier
    , workflowEventTimestamp :: Text
    } deriving stock (Show, Eq)
instance FromJSON params => FromJSON (WorkflowEvent params) where
    parseJSON = withObject "WorkflowEvent" $ \o -> WorkflowEvent
        <$> o .: "payload" <*> (WorkflowIdentifier <$> o .: "instanceIdentifier") <*> o .: "timestamp"
type WorkflowHandler params env output = WorkflowEvent params -> WorkflowStep -> env -> IO output

createWorkflowHandler ::
    (FromJSON params, ToJSON output, BuildBindingEnv bindings, BuildDOSEnv dos) =>
    WorkflowHandler params (BindingEnv kvs dos bindings) output -> JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
createWorkflowHandler handler rawEvent rawStep rawEnv errorClass = do
    outcome <- try @SomeException $ do
        eventJSON <- jsWorkflowEvent rawEvent >>= jsValToText
        event <- either (fail . ("Invalid Workflow event: " <>)) pure (eitherDecodeStrict' (Encoding.encodeUtf8 eventJSON))
        step <- workflowStepFromJSVal rawStep errorClass
        env <- bindingEnvFromJSVal rawEnv
        value <- handler event step env
        -- Force JSON serialization and native parsing inside the exception
        -- boundary; ToJSON and fields of a lazy Haskell result may throw.
        render (object ["ok" .= True, "value" .= value])
    case outcome of
        Right value -> pure value
        Left exception -> case fromException @WorkflowNativeError exception of
            Just (WorkflowNativeError _ native) -> jsWorkflowNativeFailure native
            Nothing -> case fromException @SomeAsyncException exception of
              Just _ -> throwIO exception
              Nothing -> render (object
                [ "ok" .= False, "message" .= Text.pack (displayException exception)
                , "nonRetryable" .= (case fromException @WorkflowNonRetryableError exception of Just _ -> True; Nothing -> False) ])
  where
    render value = do
        raw <- textToJSVal (Encoding.decodeUtf8 (Lazy.toStrict (encode value))) >>= jsWorkflowJSONValue
        decoded <- decodeEnveloped pure raw
        either (fail . Text.unpack) pure decoded

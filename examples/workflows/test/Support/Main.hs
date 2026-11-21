{-# LANGUAGE CPP #-}

module Main (main) where
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage, withDeferredCoverage)
#endif
import Cloudflare.Workers.Binding.D1 (D1 (..))
import Cloudflare.Workers.Binding.Workflow
import Cloudflare.Workers.Entrypoint.Workflow (createWorkflowHandler)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import WorkersSupport.Interop (jsValToText, textToJSVal)
import Control.Exception (try)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Proxy (Proxy (..))
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)
import Support.WorkflowFixture (runFixture)

type WorkflowBindings = BindingEnv '[] '[] '[ '("AUDIT", D1)]
main :: IO ()
main = pure ()

workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
workflowFixture = createWorkflowHandler $ \event step (env :: WorkflowBindings) ->
    runFixture (getBinding (Proxy @"AUDIT") env) event step
#ifdef WASM_COVERAGE
coverage_workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
coverage_workflowFixture argument0 argument1 argument2 argument3 = withDeferredCoverage (workflowFixture argument0 argument1 argument2 argument3)
foreign export javascript "workflowFixture" coverage_workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "workflowFixture" workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#endif

workflowControlFixture :: JSVal -> JSVal -> IO JSVal
workflowControlFixture raw methodValue = do
    method <- jsValToText methodValue
    instance' <- workflowGet (Workflow raw :: Workflow Value) (WorkflowIdentifier "control-test")
    result <- try @WorkflowError $ do
        case method of
            "pause" -> workflowPause instance'
            "resume" -> workflowResume instance'
            "terminate" -> workflowTerminate instance'
            _ -> workflowRestart instance'
        workflowStatus instance' :: IO (WorkflowStatus Value)
    let value = case result of
            Right snapshot -> object ["ok" .= True, "state" .= show (workflowState snapshot)]
            Left failure -> object ["ok" .= False, "operation" .= workflowErrorOperation failure, "message" .= workflowErrorMessage failure]
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode value)))
#ifdef WASM_COVERAGE
coverage_workflowControlFixture :: JSVal -> JSVal -> IO JSVal
coverage_workflowControlFixture argument0 argument1 = withCoverage (workflowControlFixture argument0 argument1)
foreign export javascript "workflowControlFixture" coverage_workflowControlFixture :: JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "workflowControlFixture" workflowControlFixture :: JSVal -> JSVal -> IO JSVal
#endif

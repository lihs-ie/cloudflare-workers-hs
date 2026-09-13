{-# LANGUAGE CPP #-}
module Main (main) where
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage)
#endif
import Cloudflare.Workers.Binding.Workflow
import Control.Exception (try)
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Data.Aeson (Value, object, (.=))
import Cloudflare.Workers.Binding.D1 (D1 (..))
import Cloudflare.Workers.Entrypoint.Workflow (createWorkflowHandler)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Data.Proxy (Proxy (..))
import GHC.Wasm.Prim (JSVal)
import Data.Aeson (encode)
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import Support.D1QueryFixture (runD1QueryFixture)
import Support.WorkflowFixture (runFixture)
type WorkflowBindings = BindingEnv '[] '[] '[ '("AUDIT", D1)]
main :: IO ()
main = pure ()

workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
workflowFixture = createWorkflowHandler $ \event step (env :: WorkflowBindings) ->
    runFixture (getBinding (Proxy @"AUDIT") env) event step
#ifdef WASM_COVERAGE
coverage_workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
coverage_workflowFixture argument0 argument1 argument2 argument3 = withCoverage (workflowFixture argument0 argument1 argument2 argument3)
foreign export javascript "workflowFixture" coverage_workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "workflowFixture" workflowFixture :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#endif

d1QueryFixture :: JSVal -> IO JSVal
d1QueryFixture database = do
    result <- runD1QueryFixture (D1 database)
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode result)))
#ifdef WASM_COVERAGE
coverage_d1QueryFixture :: JSVal -> IO JSVal
coverage_d1QueryFixture argument0 = withCoverage (d1QueryFixture argument0)
foreign export javascript "d1QueryFixture" coverage_d1QueryFixture :: JSVal -> IO JSVal
#else
foreign export javascript "d1QueryFixture" d1QueryFixture :: JSVal -> IO JSVal
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

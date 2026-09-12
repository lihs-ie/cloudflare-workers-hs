{-# LANGUAGE CPP #-}
module Main (main) where
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage)
#endif
import Cloudflare.Workers.Binding.D1 (D1 (..))
import Cloudflare.Workers.Binding.Workflow (Workflow)
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Entrypoint.Workflow (createWorkflowHandler)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Data.Proxy (Proxy (..))
import GHC.Wasm.Prim (JSVal)
import Servant.Cloudflare.Workers.Server (Context (..), serveWithContext)
import WorkflowExample.API (API)
import WorkflowExample.Application (server, runApproval)
import WorkflowExample.Domain (ApprovalRequest)

type HTTPBindings = BindingEnv '[] '[] '[ '("APPROVALS", Workflow ApprovalRequest), '("AUDIT", D1)]
type WorkflowBindings = BindingEnv '[] '[] '[ '("AUDIT", D1)]
main :: IO ()
main = pure ()
fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
fetch = createFetchHandler $ \request (env :: HTTPBindings) context ->
    serveWithContext (Proxy @API) EmptyContext (server (getBinding (Proxy @"APPROVALS") env) (getBinding (Proxy @"AUDIT") env)) request context ()
#ifdef WASM_COVERAGE
coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_fetch argument0 argument1 argument2 = withCoverage (fetch argument0 argument1 argument2)
foreign export javascript "fetch" coverage_fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "fetch" fetch :: JSVal -> JSVal -> JSVal -> IO JSVal
#endif
workflow :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
workflow = createWorkflowHandler $ \event step (env :: WorkflowBindings) ->
    runApproval (getBinding (Proxy @"AUDIT") env) event step
#ifdef WASM_COVERAGE
coverage_workflow :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
coverage_workflow argument0 argument1 argument2 argument3 = withCoverage (workflow argument0 argument1 argument2 argument3)
foreign export javascript "workflow" coverage_workflow :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#else
foreign export javascript "workflow" workflow :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
#endif

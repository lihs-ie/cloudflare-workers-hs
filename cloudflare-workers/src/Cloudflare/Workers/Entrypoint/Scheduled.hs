module Cloudflare.Workers.Entrypoint.Scheduled (
    ScheduledController (..),
    ScheduledHandler,
    createScheduledHandler,
) where

import Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv, BuildDOSEnv)
import Cloudflare.Workers.Internal.FFI.Scheduled (scheduledControllerCronViaFFI, scheduledControllerNoRetryViaFFI, scheduledControllerScheduledTimeMillisViaFFI)
import Cloudflare.Workers.Reactor (WorkersExecutionContext (WorkersExecutionContext))
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

data ScheduledController = ScheduledController
    { scheduledControllerCron :: Text
    , scheduledControllerScheduledTime :: Integer
    , scheduledControllerNoRetry :: IO ()
    }

type ScheduledHandler env = ScheduledController -> env -> WorkersExecutionContext -> IO ()

createScheduledHandler ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    ScheduledHandler (BindingEnv kvs dos bindings) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createScheduledHandler handler controllerJSVal envJSVal contextJSVal = do
    controller <- scheduledControllerFromJSVal controllerJSVal
    bindings <- bindingEnvFromJSVal envJSVal
    handler controller bindings (WorkersExecutionContext contextJSVal)

scheduledControllerFromJSVal :: JSVal -> IO ScheduledController
scheduledControllerFromJSVal controllerJSVal = do
    cron <- scheduledControllerCronViaFFI controllerJSVal
    scheduledTimeMillis <- scheduledControllerScheduledTimeMillisViaFFI controllerJSVal
    pure
        ScheduledController
            { scheduledControllerCron = cron
            , scheduledControllerScheduledTime = scheduledTimeMillis
            , scheduledControllerNoRetry = scheduledControllerNoRetryViaFFI controllerJSVal
            }

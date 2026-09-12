module Cloudflare.Workers.Entrypoint.Tail (
    TailEvent (..),
    TailHandler,
    createTailHandler,
) where

import Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv, BuildDOSEnv)
import Cloudflare.Workers.Internal.FFI.Tail (
    tailEventEventTimestampMillisViaFFI,
    tailEventJSValuesViaFFI,
    tailEventOutcomeViaFFI,
    tailEventScriptNameViaFFI,
 )
import Cloudflare.Workers.Reactor (WorkersExecutionContext (WorkersExecutionContext))
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

data TailEvent = TailEvent
    { tailEventScriptName :: Maybe Text
    , tailEventOutcome :: Text
    , tailEventEventTimestamp :: Maybe Integer
    }
    deriving stock (Show, Eq)

type TailHandler env = [TailEvent] -> env -> WorkersExecutionContext -> IO ()

createTailHandler ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    TailHandler (BindingEnv kvs dos bindings) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createTailHandler handler eventsJSVal envJSVal contextJSVal = do
    events <- tailEventsFromJSVal eventsJSVal
    bindings <- bindingEnvFromJSVal envJSVal
    handler events bindings (WorkersExecutionContext contextJSVal)

tailEventsFromJSVal :: JSVal -> IO [TailEvent]
tailEventsFromJSVal eventsJSVal = do
    itemJSVals <- tailEventJSValuesViaFFI eventsJSVal
    traverse tailEventFromJSVal itemJSVals

tailEventFromJSVal :: JSVal -> IO TailEvent
tailEventFromJSVal itemJSVal = do
    scriptName <- tailEventScriptNameViaFFI itemJSVal
    outcome <- tailEventOutcomeViaFFI itemJSVal
    eventTimestamp <- tailEventEventTimestampMillisViaFFI itemJSVal
    pure (TailEvent scriptName outcome eventTimestamp)

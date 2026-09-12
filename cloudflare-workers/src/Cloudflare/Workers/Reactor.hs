module Cloudflare.Workers.Reactor (
    initializeRTS,
    WorkersExecutionContext (..),
    passThroughOnException,
    waitUntil,
) where

import Cloudflare.Workers.Internal.FFI.Reactor (ctxWaitUntil, contextPassThroughOnExceptionViaFFI)
import GHC.Wasm.Prim (JSVal)

newtype WorkersExecutionContext = WorkersExecutionContext JSVal

waitUntil :: WorkersExecutionContext -> IO () -> IO ()
waitUntil (WorkersExecutionContext contextJSValue) = ctxWaitUntil contextJSValue

passThroughOnException :: WorkersExecutionContext -> IO ()
passThroughOnException (WorkersExecutionContext context) = contextPassThroughOnExceptionViaFFI context

-- | Compatibility no-op. The JavaScript host must initialize the RTS before
-- entering Haskell; this action cannot initialize an unstarted Haskell runtime.
initializeRTS :: IO ()
initializeRTS = pure ()

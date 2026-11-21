module Cloudflare.Workers.Internal.FFI.Abort (
    jsNewAbortController,
    jsAbortSignal,
    jsAbort,
    jsAborted,
) where

import GHC.Wasm.Prim (JSVal)

foreign import javascript unsafe "new AbortController()"
    jsNewAbortController :: IO JSVal

foreign import javascript unsafe "$1.signal"
    jsAbortSignal :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.abort()"
    jsAbort :: JSVal -> IO ()

foreign import javascript unsafe "$1.aborted === true"
    jsAborted :: JSVal -> IO Bool

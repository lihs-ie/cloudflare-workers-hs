module Cloudflare.Workers.Internal.FFI.Env (envFromJSVal) where

import Control.Monad (foldM)
import Control.Exception (throwIO)
import Data.Map (Map)
import Data.Map.Strict qualified as Map
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText)

envFromJSVal :: JSVal -> IO (Map Text JSVal)
envFromJSVal envJSValue = do
    outcome <- jsEnvironmentEntries envJSValue >>= decodeEnveloped decodeEntries
    either (throwIO . userError . Text.unpack) pure outcome
  where
    decodeEntries entries = do
        entryCount <- jsArrayLength entries
        foldM (accumulateBinding entries) Map.empty [0 .. entryCount - 1]

    accumulateBinding entries accumulateMap index = do
        pair <- jsArrayIndex entries index
        keyJSValue <- jsArrayIndex pair 0
        keyText <- jsValToText keyJSValue
        valueJSValue <- jsArrayIndex pair 1
        pure (Map.insert keyText valueJSValue accumulateMap)

-- Snapshot keys and values inside the protected JS boundary. Environment
-- getters and Proxy traps must not unwind the reactor or expose secret values
-- through diagnostics. Enumeration semantics remain Object.keys-compatible.
foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: Object.entries($1) };
      } catch (_) {
        return { ok: false, message: 'Could not read Worker environment' };
      }
    })()
    """
    jsEnvironmentEntries :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.length"
    jsArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsArrayIndex :: JSVal -> Int -> IO JSVal

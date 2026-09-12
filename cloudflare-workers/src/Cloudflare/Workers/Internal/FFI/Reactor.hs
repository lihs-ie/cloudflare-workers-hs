module Cloudflare.Workers.Internal.FFI.Reactor (
    ctxWaitUntil,
    contextPassThroughOnExceptionViaFFI,
    tailLogViaFFI,
    emitLogViaFFI,
    logRandomViaFFI,
    randomUUIDViaFFI,
    dateNowMillisViaFFI,
) where

import Control.Concurrent (forkIO)
import Control.Exception (SomeException, displayException, try, throwIO)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Data.Text (Text)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)

ctxWaitUntil :: JSVal -> IO () -> IO ()
ctxWaitUntil contextJSValue action = do
    deferredJSValue <- jsMakeDefered
    promiseJSValue <- jsDeferedPromise deferredJSValue
    jsContextWaitUntil contextJSValue promiseJSValue >>= checkContextCall
    _threadIdentifier <- forkIO (settleDeferredWith deferredJSValue action)
    pure ()

settleDeferredWith :: JSVal -> IO () -> IO ()
settleDeferredWith deferredJSVal action = do
    outcome <- try action
    case outcome of
        Right () -> jsDeferredResolve deferredJSVal
        Left exception -> do
            messageJSVal <- textToJSVal (Text.pack (displayException (exception :: SomeException)))
            jsDeferredReject deferredJSVal messageJSVal

contextPassThroughOnExceptionViaFFI :: JSVal -> IO ()
contextPassThroughOnExceptionViaFFI context = jsContextPassThroughOnException context >>= checkContextCall

-- Never let a native throw unwind through an unsafe WASM import. Decode it as
-- a Haskell exception, so callers can catch it and keep the reactor usable.
checkContextCall :: JSVal -> IO ()
checkContextCall result = decodeEnveloped (const (pure ())) result >>= either (throwIO . userError . Text.unpack) pure

tailLogViaFFI :: Text -> IO ()
tailLogViaFFI message = do
    messageJSVal <- textToJSVal message
    jsConsoleLog messageJSVal >>= checkContextCall

emitLogViaFFI :: Text -> IO ()
emitLogViaFFI message = do
    jsonTextJSVal <- textToJSVal message
    jsonObjectJSVal <- jsJSONParse jsonTextJSVal
    jsConsoleLog jsonObjectJSVal >>= checkContextCall

logRandomViaFFI :: IO Double
logRandomViaFFI = jsMathRandom

randomUUIDViaFFI :: IO Text
randomUUIDViaFFI = jsValToText =<< jsCryptoRandomUUID

dateNowMillisViaFFI :: IO Double
dateNowMillisViaFFI = jsDateNowMillis

foreign import javascript unsafe
    """
    (() => {
        let resolveFunction, rejectFunction;
        const promise = new Promise((resolve, reject) => {
            resolveFunction = resolve;
            rejectFunction = reject;
        });
        return {
          promise, resolveFunction, rejectFunction
        };
      })()
    """
    jsMakeDefered :: IO JSVal

foreign import javascript unsafe "$1.promise"
    jsDeferedPromise :: JSVal -> IO JSVal

foreign import javascript unsafe "(() => {try {$1.waitUntil($2); return {ok:true,value:null};} catch(error) {return {ok:false,message:String(error)};}})()"
    jsContextWaitUntil :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.resolveFunction()"
    jsDeferredResolve :: JSVal -> IO ()

foreign import javascript unsafe "$1.rejectFunction(new Error($2))"
    jsDeferredReject :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "(() => {try {$1.passThroughOnException(); return {ok:true,value:null};} catch(error) {return {ok:false,message:String(error)};}})()"
    jsContextPassThroughOnException :: JSVal -> IO JSVal

-- Catch native failures before they cross an unsafe WASM import. Do not inspect
-- the thrown value: even its string conversion may throw or expose credentials.
foreign import javascript unsafe "(() => {try {console.log($1); return {ok:true,value:null};} catch (_) {return {ok:false,message:'Worker console.log failed'};}})()"
    jsConsoleLog :: JSVal -> IO JSVal

foreign import javascript unsafe "JSON.parse($1)"
    jsJSONParse :: JSVal -> IO JSVal

foreign import javascript unsafe "Math.random()"
    jsMathRandom :: IO Double

foreign import javascript unsafe "crypto.randomUUID()"
    jsCryptoRandomUUID :: IO JSVal

foreign import javascript unsafe "Date.now()"
    jsDateNowMillis :: IO Double

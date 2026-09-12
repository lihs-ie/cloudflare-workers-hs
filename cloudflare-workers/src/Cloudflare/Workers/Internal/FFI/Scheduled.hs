module Cloudflare.Workers.Internal.FFI.Scheduled (
    scheduledControllerCronViaFFI,
    scheduledControllerScheduledTimeMillisViaFFI,
    scheduledControllerNoRetryViaFFI,
) where

import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

scheduledControllerCronViaFFI :: JSVal -> IO Text
scheduledControllerCronViaFFI controllerJSVal = jsValToText =<< jsScheduledControllerCronField controllerJSVal

scheduledControllerScheduledTimeMillisViaFFI :: JSVal -> IO Integer
scheduledControllerScheduledTimeMillisViaFFI = fmap round . jsScheduledControllerScheduledTimeField

scheduledControllerNoRetryViaFFI :: JSVal -> IO ()
scheduledControllerNoRetryViaFFI = jsScheduledControllerNoRetry

foreign import javascript unsafe "$1.cron"
    jsScheduledControllerCronField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const scheduledTimeMillis = $1.scheduledTime;

      if (!Number.isFinite(scheduledTimeMillis)) {
        throw new TypeError('the ScheduledController scheduledTime field is not a finite number: ' + typeof scheduledTimeMillis);
      }

      return scheduledTimeMillis;
    })()
    """
    jsScheduledControllerScheduledTimeField :: JSVal -> IO Double

foreign import javascript unsafe "$1.noRetry()"
    jsScheduledControllerNoRetry :: JSVal -> IO ()

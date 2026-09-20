{-# LANGUAGE CPP #-}

module Cloudflare.Workers.Internal.FFI.DurableObject.Transaction (
    DurableObjectTransactionError (..),
    doStorageTransactionWithViaFFI,
) where

import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Control.Exception
    ( Exception, SomeException, bracket, evaluate, mask, onException
    , throwIO, try, uninterruptibleMask_
    )
import Control.Monad (unless, void)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)
#if defined(wasm32_HOST_ARCH)
import GHC.Wasm.Prim (freeJSVal)
#endif

-- | A failure of the native transaction, retaining its original JS cause.
-- Exceptions from the Haskell callback are rethrown unchanged instead.
data DurableObjectTransactionError = DurableObjectTransactionError
    { transactionFailureMessage :: Text
    , transactionFailureCause :: JSVal
    }

instance Show DurableObjectTransactionError where
    show failure = "DurableObjectTransactionError " ++ show (transactionFailureMessage failure)

instance Exception DurableObjectTransactionError

doStorageTransactionWithViaFFI :: JSVal -> IO a -> IO a
doStorageTransactionWithViaFFI storage action = mask $ \restore ->
    bracket (start storage) release $ \control -> do
        let awaitSettlement = settled control >>= evaluate
            -- Once settlement starts, interruption must not release the bridge
            -- while its native callback is still waiting on Haskell.
            abortAndWait = uninterruptibleMask_ $ do
                finish control False
                void awaitSettlement
        outcome <- try @SomeException $ restore $ do
            entered <- ready control
            unless entered (nativeFailure control)
            action
        finish control (either (const False) (const True) outcome)
        status <- awaitSettlement `onException` abortAndWait
        case (status, outcome) of
            (1, Right value) -> pure value
            (2, Left exception) -> throwIO exception
            (3, _) -> nativeFailure control
            _ -> ioError (userError "Unexpected Durable Object transaction outcome")

nativeFailure :: JSVal -> IO a
nativeFailure control = do
    -- Retain the cause before the controller reference is released.
    cause <- nativeError control >>= evaluate
    message <- nativeMessage control >>= jsValToText
    throwIO (DurableObjectTransactionError message cause)

release :: JSVal -> IO ()
#if defined(wasm32_HOST_ARCH)
release = freeJSVal
#else
-- Host builds use the repository's non-executing JSFFI shim.
release _ = pure ()
#endif

-- A per-call sentinel distinguishes callback rejection from native failure.
-- The callback may enter after cancellation; requested records that outcome.
foreign import javascript unsafe
    """
    (() => {
      const aborted = {};
      const control = {finish: null, requested: null, error: null};
      let entered;
      control.ready = new Promise(resolve => { entered = resolve; });
      control.done = Promise.resolve().then(() => {
        if (!$1.sql) {
          throw new Error('Callback transactions require SQLite-backed Durable Object storage');
        }
        return $1.transaction(() => {
          const body = new Promise((resolve, reject) => {
            control.finish = success => success ? resolve() : reject(aborted);
            if (control.requested !== null) {
              control.finish(control.requested);
            }
          });
          entered(true);
          return body;
        });
      }).then(() => 1, error => {
        control.error = error;
        entered(false);
        return error === aborted ? 2 : 3;
      });
      return control;
    })()
    """
    start :: JSVal -> IO JSVal

foreign import javascript safe "$1.ready"
    ready :: JSVal -> IO Bool

foreign import javascript safe "$1.done"
    settled :: JSVal -> IO Int

foreign import javascript unsafe
    """
    (() => {
      $1.requested = $2;
      if ($1.finish !== null) {
        $1.finish($2);
      }
    })()
    """
    finish :: JSVal -> Bool -> IO ()

foreign import javascript unsafe "$1.error"
    nativeError :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
        return String($1.error);
      } catch (_) {
        return 'Unprintable transaction error';
      }
    })()
    """
    nativeMessage :: JSVal -> IO JSVal

module DurableObject.TransactionLifecycle (lifecycleChecks) where

import Cloudflare.Workers.Binding.DurableObject
import Control.Concurrent
import Control.Exception
import Control.Monad (unless, void)
import Data.Aeson (Value, object, (.=))
import Data.IORef
import Data.Text qualified as Text
import DurableObject.Wait (pause)
import GHC.Wasm.Prim (JSVal)

-- Controlled native test doubles cover lifecycle states that are difficult to
-- force deterministically in workerd (entry/commit failures and cancellation).
lifecycleChecks :: IO Value
lifecycleChecks = do
    mapM_ failure [0, 1, 2, 3, 6]
    cancellation 4
    cancellation 5
    pure $ object ["nativeFailures" .= True, "queuedCancellation" .= True, "commitCancellation" .= True]
  where
    failure mode = do
        fixture <- newFixture mode
        invoked <- newIORef False
        result <- try @DurableObjectTransactionError $
            doStorageTransactionWith (DurableObjectStorage fixture) (writeIORef invoked True)
        case result of
            Left exception -> do
                unless ("DurableObjectTransactionError " `Text.isPrefixOf`
                    Text.pack (displayException exception))
                    (fail "Transaction diagnostics lost their exception type")
                unless (Text.isInfixOf "fixture" (transactionFailureMessage exception)
                    || mode == 3
                    || (mode == 6 && Text.isInfixOf "SQLite" (transactionFailureMessage exception)))
                    (fail "Native error message was lost")
            Right () -> fail "Native failure was swallowed"
        ran <- readIORef invoked
        unless (ran == (mode == 1)) (fail "Callback ran in an incorrect native phase")
    cancellation mode = do
        fixture <- newFixture mode
        result <- newEmptyMVar
        invoked <- newIORef False
        thread <- forkIO $ do
            outcome <- try @SomeException $
                doStorageTransactionWith (DurableObjectStorage fixture) (writeIORef invoked True)
            putMVar result outcome
        waitPhase fixture >>= evaluate
        killer <- newEmptyMVar
        void $ forkIO (killThread thread >> putMVar killer ())
        pause 1
        releasePhase fixture
        takeMVar killer
        outcome <- takeMVar result
        case outcome of
            Left exception | fromException exception == Just ThreadKilled -> pure ()
            _ -> fail "Cancellation was not propagated"
        finished <- hasSettled fixture
        unless finished (fail "Bridge returned before native settlement")
        ran <- readIORef invoked
        unless (ran == (mode == 5)) (fail "Cancelled callback ran in the wrong phase")

foreign import javascript unsafe
    """
    (() => {
      const mode = $1;
      const error = mode === 3
        ? {toString() { throw new Error('unprintable fixture'); }}
        : new Error('fixture native failure');
      let release, reached;
      const gate = new Promise(resolve => { release = resolve; });
      const phase = new Promise(resolve => { reached = resolve; });
      return {
        get sql() {
          if (mode === 6) {
            return undefined;
          }
          if (mode === 2 || mode === 3) {
            throw error;
          }
          return {};
        },
        error, phase, release, settled: false,
        async transaction(callback) {
          try {
            if (mode === 0) {
              throw error;
            }
            if (mode === 4) {
              reached();
              await gate;
            }
            await callback();
            if (mode === 1) {
              throw error;
            }
            if (mode === 5) {
              reached();
              await gate;
            }
          } finally {
            this.settled = true;
          }
        }
      };
    })()
    """
    newFixture :: Int -> IO JSVal

foreign import javascript safe "$1.phase"
    waitPhase :: JSVal -> IO ()
foreign import javascript unsafe "$1.release()"
    releasePhase :: JSVal -> IO ()
foreign import javascript unsafe "$1.settled"
    hasSettled :: JSVal -> IO Bool

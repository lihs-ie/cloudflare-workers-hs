module Support.Runtime.GenerationAsync (generationAsyncProbe) where

import Control.Concurrent (forkFinally, forkIO, newEmptyMVar, putMVar, takeMVar, throwTo, yield, threadDelay)
import Control.Exception (AsyncException(ThreadKilled), SomeAsyncException, SomeException, fromException)
import ExampleSupport.Interop (textToJSVal)
import GHC.Wasm.Prim (JSVal)
import Quickstart.Runtime (generationQueue)
import System.Timeout (timeout)
import Data.Text qualified

-- The test resolves ready only after its blocked database batch has been entered. Cancellation
-- is delivered to the actual queue consumer as a Haskell asynchronous exception.
-- A JavaScript promise rejection cannot exercise this exception classification.
generationAsyncProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
generationAsyncProbe batch environment context ready = do
  finished <- newEmptyMVar
  worker <- forkFinally (generationQueue batch environment context) (putMVar finished)
  readiness <- timeout 4000000 waitReady
  -- A safe JavaScript FFI call cannot finish cancellation until its Promise
  -- settles. Queue the asynchronous exception on a separate Haskell thread,
  -- let that sender block in throwTo, then resolve the fixture database call.
  cancellation <- newEmptyMVar
  _ <- forkIO (throwTo worker ThreadKilled >> putMVar cancellation ())
  yield
  releaseDatabase ready
  takeMVar cancellation
  outcome <- takeMVar finished
  textToJSVal $ case readiness of
    Nothing -> "readiness-timeout"
    Just () -> classify outcome
 where
  waitReady = do
    state <- readyState ready
    if state == 1 then pure () else threadDelay 1000 >> waitReady
  classify :: Either SomeException () -> Data.Text.Text
  classify outcome = case outcome of
    Left exception -> case fromException exception :: Maybe SomeAsyncException of
      Just _ -> "asynchronous"
      Nothing -> "synchronous"
    Right () -> "completed"

foreign import javascript unsafe "$1.isReady() ? 1 : 0" readyState :: JSVal -> IO Int
foreign import javascript unsafe "$1.unblock()" releaseDatabase :: JSVal -> IO ()

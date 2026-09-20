module DurableObject.Wait (pause) where

import Control.Exception (evaluate)

-- Force the async JSFFI thunk, including its unit value, before continuing.
pause :: Int -> IO ()
pause milliseconds = wait milliseconds >>= evaluate

foreign import javascript safe
    "new Promise(resolve => setTimeout(resolve, $1))"
    wait :: Int -> IO ()

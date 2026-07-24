module Cloudflare.Workers.Reactor (
    Context (..),
    initializeRTS,
    passThroughOnException,
    waitUntil,
) where

data Context = Context
    deriving stock (Show, Eq)

waitUntil :: IO () -> IO ()
waitUntil action = action

passThroughOnException :: Context -> IO ()
passThroughOnException _context = pure ()

initializeRTS :: IO ()
initializeRTS = pure ()

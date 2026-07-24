module Main (main) where

import GHC.Wasm.Prim (JSVal)

main :: IO ()
main = pure ()

jsFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
jsFetch = error "unimplemented"

foreign export javascript "fetch" jsFetch :: JSVal -> JSVal -> JSVal -> IO JSVal

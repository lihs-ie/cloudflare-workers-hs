module Cloudflare.Workers.Internal.NativeResponse (
    NativeResponse (..),
    ResponseEncoding (..),
) where

import Cloudflare.Workers.Headers (Headers)

import GHC.Wasm.Prim (JSVal)

newtype NativeResponse = NativeResponse (Int -> Headers -> IO JSVal)

data ResponseEncoding
    = ResposneAutomatic
    | ResponseManual
    deriving stock (Show, Eq)

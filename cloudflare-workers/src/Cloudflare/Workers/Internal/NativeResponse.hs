module Cloudflare.Workers.Internal.NativeResponse (
    NativeResponse (..),
) where

import Cloudflare.Workers.Headers (Headers)

import GHC.Wasm.Prim (JSVal)

newtype NativeResponse = NativeResponse (Int -> Headers -> IO JSVal)

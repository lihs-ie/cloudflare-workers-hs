module Cloudflare.Workers.Internal.Streaming (
    ReadableStream,
    readableStreamFromJSVal,
    readableStreamToJSVal,
) where

import GHC.Wasm.Prim (JSVal)

newtype ReadableStream = ReadableStream JSVal

readableStreamFromJSVal :: JSVal -> ReadableStream
readableStreamFromJSVal = ReadableStream

readableStreamToJSVal :: ReadableStream -> JSVal
readableStreamToJSVal (ReadableStream streamJSValue) = streamJSValue

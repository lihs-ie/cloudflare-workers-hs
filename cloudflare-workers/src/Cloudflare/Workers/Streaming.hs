module Cloudflare.Workers.Streaming (
    ReadableStream (..),
    WritableStream (..),
    readableStreamToLazyByteString,
    lazyByteStringToReadableStream,
) where

import Data.ByteString.Lazy qualified as LazyByteString

data ReadableStream = ReadableStream
    deriving stock (Show, Eq)

data WritableStream = WritableStream
    deriving stock (Show, Eq)

readableStreamToLazyByteString :: ReadableStream -> IO LazyByteString.ByteString
readableStreamToLazyByteString _ = pure LazyByteString.empty

lazyByteStringToReadableStream :: LazyByteString.ByteString -> IO ReadableStream
lazyByteStringToReadableStream _ = pure ReadableStream

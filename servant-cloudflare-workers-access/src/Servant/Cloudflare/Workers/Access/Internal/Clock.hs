{-# LANGUAGE CPP #-}

module Servant.Cloudflare.Workers.Access.Internal.Clock (
    currentEpochSeconds,
) where

#if defined(wasm32_HOST_ARCH)
import Servant.Cloudflare.Workers.Access.Internal.FFI.SubtleCrypto (jsDateNowMillis)
#else
import Data.Time.Clock.POSIX (getPOSIXTime)
#endif

currentEpochSeconds :: IO Integer
#if defined(wasm32_HOST_ARCH)
currentEpochSeconds = do
  epochMillis <- jsDateNowMillis
  pure (floor (epochMillis / 1000))
#else
currentEpochSeconds = floor <$> getPOSIXTime
#endif

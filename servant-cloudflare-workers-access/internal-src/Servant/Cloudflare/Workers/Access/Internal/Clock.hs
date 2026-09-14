{-# LANGUAGE CPP #-}

module Servant.Cloudflare.Workers.Access.Internal.Clock (
    currentEpochSeconds,
) where

#if defined(wasm32_HOST_ARCH)
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

#if defined(wasm32_HOST_ARCH)
foreign import javascript unsafe "Date.now()"
    jsDateNowMillis :: IO Double
#endif

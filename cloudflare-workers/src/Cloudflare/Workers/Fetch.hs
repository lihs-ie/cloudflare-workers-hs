module Cloudflare.Workers.Fetch (
    FetchOptions (..),
    defaultFetchOptions,
    FetchError (..),
    FetchResponse (..),
    fetch,
) where

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Internal.FFI.Fetch (fetchViaFFI)
import Data.Text (Text)

newtype FetchOptions = FetchOptions
    { fetchOptionsTimeoutMilliseconds :: Int
    }
    deriving stock (Show, Eq)

defaultFetchOptions :: FetchOptions
defaultFetchOptions = FetchOptions{fetchOptionsTimeoutMilliseconds = 10000}

data FetchError
    = FetchTimedOut Text
    | FetchSubrequestLimitExceeded Text
    | FetchNetworkFailed Text
    deriving stock (Show, Eq)

data FetchResponse = FetchResponse
    { fetchResponseValue :: Response
    , fetchResponseStatusText :: Text
    }

fetch :: FetchOptions -> Request -> IO (Either FetchError FetchResponse)
fetch options request = do
    outcome <- fetchViaFFI (fetchOptionsTimeoutMilliseconds options) request
    pure $ case outcome of
        Left ("timeout", message) -> Left (FetchTimedOut message)
        Left ("subrequest-limit", message) -> Left (FetchSubrequestLimitExceeded message)
        Left (_, message) -> Left (FetchNetworkFailed message)
        Right (response, statusText) -> Right (FetchResponse response statusText)

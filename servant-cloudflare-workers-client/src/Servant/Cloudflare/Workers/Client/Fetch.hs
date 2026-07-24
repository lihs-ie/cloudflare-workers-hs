module Servant.Cloudflare.Workers.Client.Fetch () where

import Servant.Client.Core (BaseUrl)

newtype FetchClient a = FetchClient {runFetchClient :: BaseUrl -> IO a}

instance Functor FetchClient where
    fmap f (FetchClient g) = FetchClient (fmap f . g)

instance Applicative FetchClient where
    pure x = FetchClient (\_baseURL -> pure x)
    FetchClient f <*> FetchClient x =
        FetchClient (\baseURL -> f baseURL <*> x baseURL)

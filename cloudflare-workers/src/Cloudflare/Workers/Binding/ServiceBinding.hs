module Cloudflare.Workers.Binding.ServiceBinding (
    ServiceBinding (..),
    serviceBindingFetch,
) where

import Cloudflare.Workers.HTTP (Request, Response, Status (Status), createResponse)

data ServiceBinding = ServiceBindingSTUB
    deriving stock (Show, Eq)

serviceBindingFetch :: ServiceBinding -> Request -> IO Response
serviceBindingFetch _binding _request = pure (createResponse (Status 200) [] mempty)

{-# LANGUAGE OverloadedStrings #-}
module Support.Server.Requests (atPath) where
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.URL
import Data.Text (Text)
import Support.HTTP.Fixtures (request)
atPath :: Text -> Request
atPath path = case parseURL path of
  Just url -> request{requestURLField=url}
  Nothing -> error "invalid test path"

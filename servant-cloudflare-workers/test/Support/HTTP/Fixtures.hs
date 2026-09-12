{-# LANGUAGE OverloadedStrings #-}
module Support.HTTP.Fixtures (request, bodyBytes, context) where
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.URL (parseURL)
import Cloudflare.Workers.Reactor (WorkersExecutionContext(..))
import Cloudflare.Workers.HostTestKit (phantomJSVal)
import Data.ByteString.Lazy qualified as LBS
request :: Request
request = Request GET url Nothing (headersFromList []) Nothing Nothing
  where url = case parseURL "https://example.test/" of
          Just value -> value
          Nothing -> error "invalid fixed test URL"
bodyBytes :: Response -> LBS.ByteString
bodyBytes response = case responseBody response of
  ResponseBodyBytes bytes -> LBS.fromStrict bytes
  ResponseBodyLazyBytes bytes -> bytes
  _ -> error "expected buffered response"
context :: WorkersExecutionContext
context = WorkersExecutionContext phantomJSVal

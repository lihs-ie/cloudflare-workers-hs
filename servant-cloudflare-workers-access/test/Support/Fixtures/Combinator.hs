module Support.Fixtures.Combinator (request, executionContext, claims, responseBytes) where

import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.HostTestKit (phantomJSVal)
import Cloudflare.Workers.Reactor (WorkersExecutionContext (..))
import Cloudflare.Workers.URL (parseURL)
import Data.ByteString.Lazy qualified as LBS
import Servant.Cloudflare.Workers.Access

request :: Request
request = Request GET url Nothing (headersFromList []) Nothing Nothing
  where
    url = case parseURL "https://example.test/" of
        Just value -> value
        Nothing -> error "invalid fixed test URL"

executionContext :: WorkersExecutionContext
executionContext = WorkersExecutionContext phantomJSVal

claims :: AccessClaims
claims = AccessClaims "member@example.test" "subject" ["audience"] "issuer" 9999999999

responseBytes :: Response -> LBS.ByteString
responseBytes response = case responseBody response of
    ResponseBodyBytes bytes -> LBS.fromStrict bytes
    ResponseBodyLazyBytes bytes -> bytes
    _ -> error "expected buffered response"

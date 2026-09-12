{-# LANGUAGE DataKinds #-}
{-# LANGUAGE OverloadedStrings #-}
module Support.Conformance.Worker (evaluateWorker) where
import Cloudflare.Workers.HTTP qualified as HTTP
import Cloudflare.Workers.Headers qualified as Headers
import Cloudflare.Workers.URL (parseURL)
import Data.Proxy (Proxy(..))
import Data.Text.Encoding qualified as Text
import Servant.API ((:<|>)(..))
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()
import Support.Conformance.Oracle
import Support.HTTP.Fixtures (request, context, bodyBytes)
evaluateWorker :: RequestCase -> IO Observation
evaluateWorker input = do
  url <- maybe (fail "invalid conformance URL") pure (parseURL (Text.decodeUtf8 (requestTarget input)))
  let req = request
        { HTTP.requestMethodField = HTTP.methodFromText (Text.decodeUtf8 (requestMethod input))
        , HTTP.requestURLField = url
        , HTTP.requestHeaders = Headers.headersFromList [(Text.decodeUtf8 name, Text.decodeUtf8 value) | (name,value) <- requestHeaders input]
        , HTTP.requestBodyReaderField = Just (\_ -> pure (Right (requestBody input)))
        }
  response <- serveWithContext (Proxy @ReferenceAPI) EmptyContext
    (pure "hello" :<|> pure :<|> pure :<|> pure :<|> pure :<|> pure "plain") req context ()
  pure Observation
    { responseStatus = HTTP.statusCode (HTTP.responseStatus response)
    , responseContentType = Text.encodeUtf8 <$> Headers.headerLookup "Content-Type" (HTTP.responseHeaders response)
    , responseBody = bodyBytes response
    }

module Cloudflare.Workers.HTTP (
    Method (..),
    Status (..),
    RequestBodyPlaceholder (..),
    Request (..),
    Response (..),
    requestMethod,
    requestPath,
    requestBody,
    createResponse,
) where

import Cloudflare.Workers.Streaming (ReadableStream)
import Data.ByteString (ByteString)
import Data.Text (Text)

data Method = GET | POST | PUT | DELETE | PATCH | HEAD | OPTIONS
    deriving stock (Show, Eq)

newtype Status = Status {statusCode :: Int}
    deriving stock (Show, Eq)

type Headers = [(Text, Text)]

newtype RequestBodyPlaceholder = RequestBodyPlaceholder ByteString
    deriving stock (Show, Eq)

data Request = Request
    { requestMethodField :: Method
    , requestPathField :: Text
    , requestBodyField :: ReadableStream
    , requestHeaders :: Headers
    }

data Response = Response
    { responseStatus :: Status
    , responseHeaders :: Headers
    , responseBody :: ByteString
    }
    deriving stock (Show, Eq)

requestMethod :: Request -> Method
requestMethod = requestMethodField

requestPath :: Request -> Text
requestPath = requestPathField

requestBody :: Request -> ReadableStream
requestBody = requestBodyField

createResponse :: Status -> Headers -> ByteString -> Response
createResponse = Response

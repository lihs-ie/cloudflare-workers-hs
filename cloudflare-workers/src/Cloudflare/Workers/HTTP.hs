module Cloudflare.Workers.HTTP (
    Method (..),
    Status (..),
    RequestBodyPlaceholder (..),
    Request (..),
    Response (..),
    requestMethod,
    requestPath,
    createResponse,
    defaultRequestBodyByteLimit,
    methodFromText,
    ResponseBody (..),
    PassthroughResponse (..),
    requestURL,
    requestBody,
    requestBodyReader,
    methodToText,
    requestDataCenter,
) where

import Cloudflare.Workers.Headers (Headers)
import Cloudflare.Workers.Streaming (ReadableStream, ReadableStreamReadError)
import Cloudflare.Workers.URL (URL, urlPath)
import Data.ByteString (ByteString)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

data Method
    = GET
    | POST
    | PUT
    | DELETE
    | PATCH
    | HEAD
    | OPTIONS
    | OtherMethod Text
    deriving stock (Show, Eq)

methodFromText :: Text -> Method
methodFromText "GET" = GET
methodFromText "POST" = POST
methodFromText "PUT" = PUT
methodFromText "DELETE" = DELETE
methodFromText "PATCH" = PATCH
methodFromText "HEAD" = HEAD
methodFromText "OPTIONS" = OPTIONS
methodFromText rawMethod = OtherMethod rawMethod

methodToText :: Method -> Text
methodToText GET = "GET"
methodToText POST = "POST"
methodToText PUT = "PUT"
methodToText DELETE = "DELETE"
methodToText PATCH = "PATCH"
methodToText HEAD = "HEAD"
methodToText OPTIONS = "OPTIONS"
methodToText (OtherMethod rawMethod) = rawMethod

newtype Status = Status {statusCode :: Int}
    deriving stock (Show, Eq)

newtype RequestBodyPlaceholder = RequestBodyPlaceholder ByteString
    deriving stock (Show, Eq)

data Request = Request
    { requestMethodField :: Method
    , requestURLField :: URL
    , requestBodyField :: Maybe ReadableStream
    , requestHeaders :: Headers
    , requestBodyReaderField :: Maybe (Int -> IO (Either ReadableStreamReadError LazyByteString.ByteString))
    , requestDataCenterField :: Maybe Text
    }

defaultRequestBodyByteLimit :: Int
defaultRequestBodyByteLimit = 1048576

data ResponseBody
    = ResponseBodyBytes ByteString
    | ResponseBodyLazyBytes LazyByteString.ByteString
    | ResponseBodyStream ReadableStream
    -- | An opaque native response returned unchanged to the Worker runtime.
    -- Its status, headers, and request-scoped body remain platform-owned.
    | ResponseBodyPassthrough PassthroughResponse
    | ResponseBodyWebSocket PassthroughResponse

newtype PassthroughResponse = PassthroughResponse JSVal

data Response = Response
    { responseStatus :: Status
    , responseHeaders :: Headers
    , responseBody :: ResponseBody
    }

requestMethod :: Request -> Method
requestMethod = requestMethodField

requestURL :: Request -> URL
requestURL = requestURLField

requestPath :: Request -> Text
requestPath = urlPath . requestURLField

requestBody :: Request -> Maybe ReadableStream
requestBody = requestBodyField

requestBodyReader :: Request -> Maybe (Int -> IO (Either ReadableStreamReadError LazyByteString.ByteString))
requestBodyReader = requestBodyReaderField

requestDataCenter :: Request -> Maybe Text
requestDataCenter = requestDataCenterField

createResponse :: Status -> Headers -> ResponseBody -> Response
createResponse = Response

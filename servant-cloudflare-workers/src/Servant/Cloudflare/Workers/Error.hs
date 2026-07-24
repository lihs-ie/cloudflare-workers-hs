module Servant.Cloudflare.Workers.Error (
    ServerError (..),
    err400,
    err401,
    err404,
    err405,
    err406,
    err415,
    err500,
    serverErrorToResponse,
) where

import Cloudflare.Workers.HTTP (Response, Status (Status), createResponse)
import Data.Text (Text)
import Data.Text.Encoding qualified as TextEncoding

data ServerError = ServerError
    { serverErrorStatusCode :: Int
    , serverErrorMessage :: Text
    , serverErrorHeaders :: [(Text, Text)]
    }
    deriving stock (Show, Eq)

err400, err401, err404, err405, err406, err415, err500 :: ServerError
err400 = ServerError 400 "Bad Request" []
err401 = ServerError 401 "Unauthorized" []
err404 = ServerError 404 "Not Found" []
err405 = ServerError 405 "Method Not Allowed" []
err406 = ServerError 406 "Not Acceptable" []
err415 = ServerError 415 "Unsupported Media Type" []
err500 = ServerError 500 "Internal Server Error" []

serverErrorToResponse :: ServerError -> Response
serverErrorToResponse serverError =
    createResponse
        (Status (serverErrorStatusCode serverError))
        (("content-type", "application/json; charset=utf-8") : serverErrorHeaders serverError)
        (TextEncoding.encodeUtf8 (jsonEnvelope (serverErrorMessage serverError)))
  where
    jsonEnvelope :: Text -> Text
    jsonEnvelope message = "{\"error\":\"" <> message <> "\"}"

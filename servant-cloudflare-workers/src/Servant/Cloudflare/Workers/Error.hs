module Servant.Cloudflare.Workers.Error (
    ServerError (..),
    detailLengthLimit,
    withDetail,
    err400,
    err401,
    err404,
    err405,
    err406,
    err413,
    err415,
    err500,
    serverErrorToResponse,
) where

import Cloudflare.Workers.HTTP (Request (requestHeaders), Response, ResponseBody (ResponseBodyLazyBytes), Status (Status), createResponse)
import Cloudflare.Workers.Headers (headerLookup, headersFromList)
import Data.Aeson (encode, object, (.=))
import Data.ByteString qualified as ByteString
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import Network.HTTP.Media qualified as NetworkHTTPMedia

data ServerError = ServerError
    { serverErrorStatusCode :: Int
    , serverErrorMessage :: Text
    , serverErrorHeaders :: [(Text, Text)]
    , serverErrorDetail :: Maybe Text
    }
    deriving stock (Show, Eq)

detailLengthLimit :: Int
detailLengthLimit = 512

withDetail :: Text -> ServerError -> ServerError
withDetail parserMessage serverError =
    serverError{serverErrorDetail = Just truncated}
  where
    truncated
        | Text.length parserMessage > detailLengthLimit =
            Text.take detailLengthLimit parserMessage <> "... (truncated)"
        | otherwise = parserMessage

err400, err401, err404, err405, err406, err413, err415, err500 :: ServerError
err400 = ServerError 400 "Bad Request" [] Nothing
err401 = ServerError 401 "Unauthorized" [] Nothing
err404 = ServerError 404 "Not Found" [] Nothing
err405 = ServerError 405 "Method Not Allowed" [] Nothing
err406 = ServerError 406 "Not Acceptable" [] Nothing
err413 = ServerError 413 "Payload Too Large" [] Nothing
err415 = ServerError 415 "Unsupported Media Type" [] Nothing
err500 = ServerError 500 "Internal Server Error" [] Nothing

jsonMediaType, plainTextMediaType :: NetworkHTTPMedia.MediaType
jsonMediaType = "application" NetworkHTTPMedia.// "json"
plainTextMediaType = "text" NetworkHTTPMedia.// "plain"

serverErrorToResponse :: Request -> ServerError -> Response
serverErrorToResponse request serverError =
    createResponse
        (Status (serverErrorStatusCode serverError))
        (headersFromList (("Content-Type", negotiatedContentType) : serverErrorHeaders serverError))
        (ResponseBodyLazyBytes negotiatedBody)
  where
    acceptHeaderBytes :: ByteString.ByteString
    acceptHeaderBytes = TextEncoding.encodeUtf8 (fromMaybe "*/*" (headerLookup "Accept" (requestHeaders request)))

    negotiatedMediaType :: Maybe NetworkHTTPMedia.MediaType
    negotiatedMediaType = NetworkHTTPMedia.matchAccept [jsonMediaType, plainTextMediaType] acceptHeaderBytes

    usePlainText :: Bool
    usePlainText = negotiatedMediaType == Just plainTextMediaType

    negotiatedContentType :: Text
    negotiatedContentType
        | usePlainText = "text/plain;charset=utf-8"
        | otherwise = "application/json;charset=utf-8"

    detailFields =
        maybe [] (\detailText -> ["detail" .= detailText]) (serverErrorDetail serverError)

    negotiatedBody :: LazyByteString.ByteString
    negotiatedBody
        | usePlainText =
            LazyByteString.fromStrict
                ( TextEncoding.encodeUtf8
                    ( serverErrorMessage serverError
                        <> maybe "" (": " <>) (serverErrorDetail serverError)
                    )
                )
        | otherwise =
            encode
                ( object
                    [ "error"
                        .= object
                            ( [ "status" .= serverErrorStatusCode serverError
                              , "message" .= serverErrorMessage serverError
                              ]
                                <> detailFields
                            )
                    ]
                )

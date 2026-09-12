module Servant.Cloudflare.Workers.Client.Fetch.Request (
    buildFetchTargetURL,
    requestHeadersToWorkersHeaders,
) where

import Cloudflare.Workers.Headers (Headers, headerInsert, headersFromList)
import Data.ByteString (ByteString)
import Data.ByteString.Builder qualified as Builder
import Data.ByteString.Lazy qualified as LazyByteString
import Data.CaseInsensitive (CI (original))
import Data.Foldable (Foldable (toList))
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import Data.Text.Encoding.Error qualified as TextEndodingError
import Network.HTTP.Media (RenderHeader (renderHeader))
import Network.HTTP.Types (urlEncode)
import Servant.Client.Core (
    BaseUrl,
    Request,
    RequestF (
        requestAccept,
        requestBody,
        requestHeaders,
        requestPath,
        requestQueryString
    ),
    showBaseUrl,
 )

decodeUTF8Lenient :: ByteString -> Text
decodeUTF8Lenient = TextEncoding.decodeUtf8With TextEndodingError.lenientDecode

buildFetchTargetURL :: BaseUrl -> Request -> Text
buildFetchTargetURL baseURL request =
    Text.pack (showBaseUrl baseURL)
        <> decodeUTF8Lenient (LazyByteString.toStrict (Builder.toLazyByteString (requestPath request)))
        <> queryStringText (toList (requestQueryString request))
  where
    queryStringText [] = Text.empty
    queryStringText queryItems = "?" <> Text.intercalate "&" (map queryItemText queryItems)

    queryItemText (name, maybeValue) =
        decodeUTF8Lenient (urlEncode True name) <> maybe Text.empty (\value -> "=" <> decodeUTF8Lenient value) maybeValue

requestHeadersToWorkersHeaders :: Request -> Headers
requestHeadersToWorkersHeaders request =
    case maybeAcceptText of
        Nothing -> headerWithContentType
        Just acceptText -> headerInsert "Accept" acceptText headerWithContentType
  where
    maybeContentTypeText :: Maybe Text
    maybeContentTypeText = decodeUTF8Lenient . renderHeader . snd <$> requestBody request

    decodeHeaderPair :: (CI ByteString, ByteString) -> (Text, Text)
    decodeHeaderPair (name, value) = (decodeUTF8Lenient (original name), decodeUTF8Lenient value)

    passthroughHeaders =
        filter (\(name, _) -> name /= "Accept" && name /= "Content-Type") (toList (requestHeaders request))

    decodedPassthroughHeaders = headersFromList (map decodeHeaderPair passthroughHeaders)

    headerWithContentType = case maybeContentTypeText of
        Nothing -> decodedPassthroughHeaders
        Just contentTypeText -> headerInsert "Content-Type" contentTypeText decodedPassthroughHeaders

    maybeAcceptText =
        if null acceptMediaTypes
            then Nothing
            else Just (decodeUTF8Lenient (renderHeader acceptMediaTypes))
      where
        acceptMediaTypes = toList (requestAccept request)

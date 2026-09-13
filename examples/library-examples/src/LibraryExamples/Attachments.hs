{- | Bounded attachment storage. Encryption is an explicit request policy and
never falls back to plaintext. Keys belong to operator configuration, not HTTP.
-}
module LibraryExamples.Attachments (attachmentHandler) where

import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Binding.Secret (Secret, revealSecret)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Control.Exception (try)
import Data.ByteString.Lazy qualified as Lazy
import Data.Char (isAlphaNum, isAscii)
import Data.Either (fromRight)
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8)

{- | Mount under @attachments :> Raw@, passing the optional operator Secret.
SSE-C configuration uses exactly 32 UTF-8 bytes; absent or invalid keys reject
encrypted requests before touching R2. Separate namespaces prevent plaintext
requests from replacing encrypted objects with the same public identifier.
-}
attachmentHandler :: R2Bucket -> Maybe Secret -> [Text] -> Request -> IO Response
attachmentHandler bucket secret [identifier] request
    | validIdentifier identifier = case encryption of
        Left response -> pure response
        Right (namespace, key) -> do
            result <- try @R2Error (dispatch (namespace <> identifier) key)
            -- Native errors may contain implementation details. Neither keys
            -- nor the raw exception are rendered or logged at this boundary.
            pure (fromRight (failure 502 "Attachment storage failed") result)
  where
    encryption = case headerLookup "X-Attachment-Encryption" (requestHeaders request) of
        Nothing -> Right ("attachments/plain/", Nothing)
        Just "sse-c" -> case secret >>= mkR2SsecKey . encodeUtf8 . revealSecret of
            Nothing -> Left (failure 503 "Attachment encryption is unavailable")
            Just key -> Right ("attachments/encrypted/", Just key)
        Just _ -> Left (failure 400 "Unsupported attachment encryption")
    dispatch objectKey key = case requestMethod request of
        PUT -> case requestBodyReader request of
            Nothing -> pure (failure 400 "Attachment body is required")
            Just readBody -> do
                bytes <- readBody 1048576
                case bytes of
                    Left _ -> pure (failure 413 "Attachment exceeds the readable size limit")
                    Right body -> do
                        stored <-
                            r2Put
                                bucket
                                objectKey
                                (R2PutBytes (Lazy.toStrict body))
                                r2PutDefaultOptions
                                    { r2ExtendedPutHttpMetadata =
                                        r2HttpMetadataDefault
                                            { r2HttpMetadataContentType = Just (fromMaybe "application/octet-stream" (headerLookup "Content-Type" (requestHeaders request)))
                                            , r2HttpMetadataContentDisposition = Just ("attachment; filename=\"" <> identifier <> "\"")
                                            , r2HttpMetadataCacheControl = Just "private, no-store"
                                            }
                                    , r2ExtendedPutSsecKey = key
                                    }
                        pure $ case stored of
                            R2PutStored _ -> createResponse (Status 201) safeHeaders (ResponseBodyBytes "Stored")
                            R2PutPreconditionFailed -> failure 409 "Attachment write conflict"
        GET -> do
            found <- r2Get bucket objectKey r2GetDefaultOptions{r2GetOptionsSsecKey = key}
            case found of
                R2GetNotFound -> pure (failure 404 "Attachment not found")
                R2GetSuccess object -> do
                    metadata <- r2ObjectWriteHttpMetadata object safeHeaders
                    pure
                        ( createResponse
                            (Status 200)
                            (headerInsert "ETag" (r2ObjectMetaHttpETag (r2ObjectMeta object)) metadata)
                            (ResponseBodyStream (r2ObjectBody object))
                        )
                R2GetPreconditionFailed _ -> pure (failure 502 "Attachment body is unavailable")
        _ -> pure (createResponse (Status 405) (headerInsert "Allow" "GET, PUT" safeHeaders) (ResponseBodyBytes "Method not allowed"))
attachmentHandler _ _ _ _ = pure (failure 400 "Invalid attachment identifier")

validIdentifier :: Text -> Bool
validIdentifier value =
    not (Text.null value)
        && Text.length value <= 128
        && Text.all (\character -> isAscii character && (isAlphaNum character || character `elem` ['-', '_', '.'])) value
        && value /= "."
        && value /= ".."

safeHeaders :: Headers
safeHeaders = headersFromList [("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")]

failure :: Int -> Text -> Response
failure status message = createResponse (Status status) safeHeaders (ResponseBodyBytes (encodeUtf8 message))

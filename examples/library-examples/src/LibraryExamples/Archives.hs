-- | Archival uploads with explicit encryption and retention policies.
module LibraryExamples.Archives (ArchiveAPI, archiveServer) where
import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Binding.Secret (Secret, revealSecret)
import Cloudflare.Workers.Headers (headersFromList, headerInsert)
import Cloudflare.Workers.HTTP
import Control.Exception (try)
import Data.Aeson (encode, object, (.=))
import Data.Char (isAscii, isAlphaNum)
import Data.Maybe (isJust)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8)
import GHC.Generics (Generic)
import LibraryExamples.R2Archive
import Servant.API (NamedRoutes, Capture, Raw, (:>))
import Servant.API.Generic ((:-))
import Servant.Cloudflare.Workers.Server (Server)

data ArchiveRoutes mode = ArchiveRoutes
  { encrypted :: mode :- "encrypted" :> Capture "identifier" Text :> Raw
  , infrequent :: mode :- "infrequent" :> Capture "identifier" Text :> Raw
  } deriving stock (Generic)
type ArchiveAPI = NamedRoutes ArchiveRoutes

archiveServer :: R2Bucket -> Maybe Secret -> Server ArchiveAPI env
archiveServer bucket secret = ArchiveRoutes
  { encrypted = handle "encrypted" (case secret >>= mkR2SsecKey . encodeUtf8 . revealSecret of
      Nothing -> Left (failure 503 "Archive encryption is unavailable")
      Just key -> Right (Just key))
  , infrequent = handle "infrequent" (Right Nothing)
  }
 where
  handle policy encryption identifier segments request _
    | not (null segments) || not (valid identifier) = pure (failure 400 "Invalid archive identifier")
    | otherwise = case encryption of
        Left response -> pure response
        Right key -> do
          result <- try @R2Error (dispatch ("archives/" <> policy <> "/" <> identifier) key request)
          pure (either (const (failure 502 "Archive storage failed")) id result)
  dispatch objectKey key request = case requestMethod request of
    POST -> do
      meta <- maybe (archiveInfrequent bucket objectKey) (archiveMultipart bucket objectKey) key
      pure (createResponse (Status 201) (headerInsert "Content-Type" "application/json" safeHeaders)
        (ResponseBodyLazyBytes (encode (object ["size" .= r2ObjectMetaSize meta
          , "storageClass" .= show (r2ObjectMetaStorageClass meta)
          , "keyMetadataPresent" .= isJust (r2ObjectMetaSsecKeyMd5 meta)]))))
    GET -> do
      result <- r2Get bucket objectKey r2GetDefaultOptions { r2GetOptionsSsecKey = key }
      case result of
        R2GetSuccess value -> do
          headers <- r2ObjectWriteHttpMetadata value safeHeaders
          pure (createResponse (Status 200) headers (ResponseBodyStream (r2ObjectBody value)))
        R2GetNotFound -> pure (failure 404 "Archive not found")
        _ -> pure (failure 502 "Archive body unavailable")
    _ -> pure (createResponse (Status 405) (headerInsert "Allow" "POST, GET" safeHeaders) (ResponseBodyBytes "Method not allowed"))
  valid identifier = not (Text.null identifier) && Text.length identifier <= 128
    && Text.all (\character -> isAscii character && (isAlphaNum character || character `elem` ['-', '_', '.'])) identifier
    && identifier /= "." && identifier /= ".."
  safeHeaders = headersFromList [("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff")]
  failure status text = createResponse (Status status) safeHeaders (ResponseBodyBytes (encodeUtf8 text))

-- | Archival object policies. The caller owns object identifiers and retention;
-- these operations never silently downgrade an explicitly requested policy.
module LibraryExamples.R2Archive (archiveMultipart, archiveInfrequent) where

import Cloudflare.Workers.Binding.R2
import Control.Exception (onException)
import Data.ByteString qualified as Bytes
import Data.Text (Text)

-- | Publish an encrypted multipart archive, reusing the same validated key for
-- creation and every part, including parts uploaded through a resumed handle.
-- The first part is 5 MiB; the final three bytes demonstrate a smaller last part.
-- On transfer failure, abort the upload instead of leaving orphaned parts.
-- The caller retains the key securely and owns deletion of the completed object.
archiveMultipart :: R2Bucket -> Text -> R2SsecKey -> IO R2ObjectMeta
archiveMultipart bucket key encryptionKey = do
  upload <- r2CreateMultipartUpload bucket key r2MultipartDefaultOptions
    { r2MultipartSsecKey = Just encryptionKey
    , r2MultipartHttpMetadata = r2HttpMetadataDefault
        { r2HttpMetadataContentType = Just "application/octet-stream"
        , r2HttpMetadataCacheControl = Just "private, no-store" }
    , r2MultipartCustomMetadata = [("purpose", "encrypted-archive")]
    }
  flip onException (r2AbortMultipartUpload upload) $ do
    first <- r2UploadPart upload 1 (R2PutBytes (Bytes.replicate (5 * 1024 * 1024) 65)) (Just encryptionKey)
    resumed <- r2ResumeMultipartUpload bucket key (r2MultipartUploadIdentifier upload)
    lastPart <- r2UploadPart resumed 2 (R2PutBytes (Bytes.pack [0, 128, 255])) (Just encryptionKey)
    r2CompleteMultipartUpload resumed [first, lastPart]

-- | Retain a small audit archive under the explicitly selected InfrequentAccess
-- class. The returned native metadata reports the actual class; callers must
-- not infer support merely because the put completed successfully locally.
archiveInfrequent :: R2Bucket -> Text -> IO R2ObjectMeta
archiveInfrequent bucket key = do
  result <- r2Put bucket key (R2PutText "retained audit archive") r2PutDefaultOptions
    { r2ExtendedPutStorageClass = Just R2InfrequentAccess
    , r2ExtendedPutHttpMetadata = r2HttpMetadataDefault
        { r2HttpMetadataContentType = Just "text/plain"
        , r2HttpMetadataCacheControl = Just "private, no-store" }
    , r2ExtendedPutCustomMetadata = [("purpose", "infrequent-audit-archive")]
    }
  case result of
    R2PutStored meta -> pure meta
    R2PutPreconditionFailed -> fail "Unconditional archive put rejected"

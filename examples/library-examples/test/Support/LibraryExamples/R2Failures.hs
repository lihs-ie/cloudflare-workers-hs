-- | Deliberate native rejection probes belong only to the test WASM.
module Support.LibraryExamples.R2Failures (runR2FailureScenario) where
import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Streaming (readableStreamFromProducer, StreamProducerOutcome(..))
import Control.Exception (try, finally)
import Data.Aeson (Value, object, (.=))
import Data.ByteString qualified as Bytes
import Data.Maybe (isNothing)
import Data.Text (Text)

runR2FailureScenario :: R2Bucket -> Text -> IO Value
runR2FailureScenario bucket "multipart-cleanup" = cleanupMultipart bucket
runR2FailureScenario bucket "write-rejections" = flip finally (r2Delete bucket "failures/checksum") $ do
  invalidChecksum <- try @R2Error (r2Put bucket "failures/checksum" (R2PutText "payload")
    r2PutDefaultOptions { r2ExtendedPutChecksum = Just (R2ChecksumSha256 (Bytes.replicate 32 0)) })
  checksumAbsent <- r2Head bucket "failures/checksum"
  let invalidBatch = R2KeyBatch "outside/batch" (replicate 1000 "outside/batch")
  invalidDelete <- try @R2Error (r2DeleteMany bucket invalidBatch)
  pure $ object ["checksumRejected" .= isError invalidChecksum
    , "checksumObjectAbsent" .= isNothing checksumAbsent
    , "batchCount" .= r2KeyBatchCount invalidBatch, "batchInvalid" .= not (r2KeyBatchIsValid invalidBatch)
    , "invalidBatchRejected" .= isError invalidDelete]
runR2FailureScenario bucket "reader-rejections" = flip finally (r2Delete bucket "failures/readers") $ do
  _ <- r2Put bucket "failures/readers" (R2PutText "invalid JSON") r2PutDefaultOptions
  original <- fresh
  _ <- r2ObjectText original
  consumed <- try @R2Error (r2ObjectText original)
  malformed <- try @R2Error (fresh >>= r2ObjectJSON)
  pure (object ["consumedRejected" .= isError consumed, "malformedJSONRejected" .= isError malformed])
 where
  fresh = r2Get bucket "failures/readers" r2GetDefaultOptions >>= \case
    R2GetSuccess result -> pure result
    _ -> fail "Reader failure fixture missing"
runR2FailureScenario bucket "unknown-length-stream" = flip finally (r2Delete bucket "failures/stream") $ do
  stream <- readableStreamFromProducer $ \emit -> do
    _ <- emit "unknown length"
    pure StreamProducerCompleted
  rejected <- try @R2Error (r2Put bucket "failures/stream" (R2PutStream stream) r2PutDefaultOptions)
  absent <- r2Head bucket "failures/stream"
  pure (object ["unknownLengthRejected" .= isError rejected, "objectAbsent" .= isNothing absent])
runR2FailureScenario _ _ = fail "Unknown R2 failure scenario"

isError :: Either a b -> Bool
isError (Left _) = True
isError _ = False

-- A failed transfer must abort its upload. Resume uses the original identifier
-- afterward to prove cleanup affected the native upload rather than one handle.
cleanupMultipart :: R2Bucket -> IO Value
cleanupMultipart bucket = do
  upload <- r2CreateMultipartUpload bucket "cleanup.bin" r2MultipartDefaultOptions
    { r2MultipartStorageClass = Just R2Standard }
  failed <- try @R2Error $ flip finally (r2AbortMultipartUpload upload) $ do
    _ <- r2UploadPart upload 1 (R2PutText "temporary") Nothing
    r2UploadPart upload 0 (R2PutText "invalid part number") Nothing
  resumed <- r2ResumeMultipartUpload bucket (r2MultipartUploadKey upload) (r2MultipartUploadIdentifier upload)
  rejected <- try @R2Error (r2UploadPart resumed 1 (R2PutText "after cleanup") Nothing)
  absent <- r2Head bucket "cleanup.bin"
  pure $ object ["transferFailed" .= isError failed, "resumeRejected" .= isError rejected, "objectAbsent" .= isNothing absent]


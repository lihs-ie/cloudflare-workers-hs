-- | Runnable R2 scenarios use real bucket operations and bounded fixture sizes.
module LibraryExamples.R2 (runR2Scenario) where

import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Headers (headersFromList)
import Control.Exception (try, finally)
import Data.Aeson (Value, object, (.=))
import Data.ByteString qualified as Bytes
import Data.Maybe (isNothing)
import Data.Text (Text)

runR2Scenario :: R2Bucket -> Text -> IO Value
runR2Scenario bucket "conditional" = conditional bucket
runR2Scenario bucket "listing" = listing bucket
runR2Scenario bucket "range" = ranges bucket
runR2Scenario bucket "multipart" = multipart bucket
runR2Scenario bucket "abort" = abortMultipart bucket
runR2Scenario bucket "retry-complete" = retryComplete bucket
runR2Scenario bucket "readers" = readers bucket
runR2Scenario bucket "write-options" = writeOptions bucket
runR2Scenario bucket "checksums" = checksums bucket
runR2Scenario bucket "browse-options" = browseOptions bucket
runR2Scenario _ _ = fail "Unknown R2 scenario"

store :: R2Bucket -> Text -> Bytes.ByteString -> IO R2ObjectMeta
store bucket key bytes = do
  result <- r2Put bucket key (R2PutBytes bytes) r2PutDefaultOptions
    { r2ExtendedPutHttpMetadata = r2HttpMetadataDefault{r2HttpMetadataContentType = Just "application/octet-stream"}
    , r2ExtendedPutCustomMetadata = [("purpose", "library-example")]
    }
  case result of
    R2PutStored meta -> pure meta
    R2PutPreconditionFailed -> fail "Unconditional fixture put was rejected"

body :: R2GetResult -> IO Bytes.ByteString
body (R2GetSuccess result) = r2ObjectBytes result
body _ = fail "Expected R2 object body"

condition :: Maybe Text -> Maybe Text -> R2GetOptions
condition matches differs = r2GetDefaultOptions
  {r2GetOptionsOnlyIf = Just (R2OnlyIfConditional (R2Condition matches differs Nothing Nothing))}

conditional :: R2Bucket -> IO Value
conditional bucket = do
  let key = "conditional.bin"
  meta <- store bucket key (Bytes.pack [0, 128, 255, 65])
  let etag = r2ObjectMetaETag meta
      noBody (R2GetPreconditionFailed _) = True
      noBody _ = False
  matched <- r2Get bucket key (condition (Just etag) Nothing) >>= body
  wrongMatch <- r2Get bucket key (condition (Just "wrong-etag") Nothing)
  unchanged <- r2Get bucket key (condition Nothing (Just etag))
  changed <- r2Get bucket key (condition Nothing (Just "wrong-etag")) >>= body
  headerResult <- r2Get bucket key r2GetDefaultOptions
    {r2GetOptionsOnlyIf = Just (R2OnlyIfHeaders (headersFromList [("If-None-Match", r2ObjectMetaHttpETag meta)]))}
  missing <- r2Get bucket "never-created.bin" r2GetDefaultOptions
  pure $ object
    [ "matched" .= Bytes.unpack matched, "changed" .= Bytes.unpack changed
    , "wrongMatchHasNoBody" .= noBody wrongMatch, "unchangedHasNoBody" .= noBody unchanged
    , "headerConditionHasNoBody" .= noBody headerResult
    , "missing" .= (case missing of R2GetNotFound -> True; _ -> False)
    , "contentType" .= r2HttpMetadataContentType (r2ObjectMetaHttpMetadata meta)
    , "customMetadata" .= lookup "purpose" (r2ObjectMetaCustomMetadata meta)
    ]

ranges :: R2Bucket -> IO Value
ranges bucket = do
  _ <- store bucket "ranges.bin" (Bytes.pack [0..15])
  let readRange range = r2Get bucket "ranges.bin" r2GetDefaultOptions{r2GetOptionsRange = Just range} >>= body
  middle <- readRange (R2RangeOffsetLength 4 5)
  offset <- readRange (R2RangeOffset 12)
  prefix <- readRange (R2RangeLength 3)
  suffix <- readRange (R2RangeSuffix 3)
  beyond <- try @R2Error (readRange (R2RangeOffset 100))
  pure $ object
    ["middle" .= Bytes.unpack middle, "offset" .= Bytes.unpack offset, "prefix" .= Bytes.unpack prefix
    , "suffix" .= Bytes.unpack suffix, "invalidRangeRejected" .= isError beyond]

-- All non-final parts are >= 5 MiB. Resume uses the native upload identifier,
-- not the original in-memory Haskell handle, mirroring a later request.
multipart :: R2Bucket -> IO Value
multipart bucket = do
  upload <- r2CreateMultipartUpload bucket "multipart.bin" r2MultipartDefaultOptions
    { r2MultipartHttpMetadata = r2HttpMetadataDefault{r2HttpMetadataContentType = Just "application/octet-stream"}
    , r2MultipartCustomMetadata = [("purpose", "multipart-example")]
    }
  first <- r2UploadPart upload 1 (R2PutBytes (Bytes.replicate (5 * 1024 * 1024) 65)) Nothing
  resumed <- r2ResumeMultipartUpload bucket (r2MultipartUploadKey upload) (r2MultipartUploadIdentifier upload)
  second <- r2UploadPart resumed 2 (R2PutBytes (Bytes.pack [0, 128, 255])) Nothing
  completed <- r2CompleteMultipartUpload resumed [first, second]
  terminal <- try @R2Error (r2UploadPart resumed 3 (R2PutText "late") Nothing)
  repeated <- try @R2Error (r2CompleteMultipartUpload resumed [first, second])
  tailBytes <- r2Get bucket "multipart.bin" r2GetDefaultOptions{r2GetOptionsRange = Just (R2RangeSuffix 7)} >>= body
  pure $ object
    [ "size" .= r2ObjectMetaSize completed, "tail" .= Bytes.unpack tailBytes
    , "resumedSameUpload" .= (r2MultipartUploadIdentifier upload == r2MultipartUploadIdentifier resumed)
    , "partNumbers" .= [r2UploadedPartNumber first, r2UploadedPartNumber second]
    , "metadata" .= lookup "purpose" (r2ObjectMetaCustomMetadata completed)
    , "latePartRejected" .= terminalError terminal, "repeatCompleteRejected" .= terminalError repeated]

abortMultipart :: R2Bucket -> IO Value
abortMultipart bucket = do
  r2Delete bucket "aborted.bin"
  upload <- r2CreateMultipartUpload bucket "aborted.bin" r2MultipartDefaultOptions
  _ <- r2UploadPart upload 1 (R2PutText "not published") Nothing
  r2AbortMultipartUpload upload
  repeated <- try @R2Error (r2AbortMultipartUpload upload)
  resumed <- r2ResumeMultipartUpload bucket (r2MultipartUploadKey upload) (r2MultipartUploadIdentifier upload)
  late <- try @R2Error (r2UploadPart resumed 2 (R2PutText "cannot resurrect") Nothing)
  result <- r2Head bucket "aborted.bin"
  pure $ object ["objectAbsent" .= isNothing result, "repeatAbortRejected" .= terminalError repeated, "resumeAbortedRejected" .= isError late]

retryComplete :: R2Bucket -> IO Value
retryComplete bucket = do
  upload <- r2CreateMultipartUpload bucket "retry.bin" r2MultipartDefaultOptions
  part <- r2UploadPart upload 1 (R2PutText "retry-safe") Nothing
  failed <- try @R2Error (r2CompleteMultipartUpload upload [part{r2UploadedPartEtag = "wrong-etag"}])
  meta <- r2CompleteMultipartUpload upload [part]
  result <- r2Get bucket "retry.bin" r2GetDefaultOptions >>= body
  pure $ object ["failedCompleteRejected" .= isError failed, "size" .= r2ObjectMetaSize meta, "bytes" .= Bytes.unpack result]

isError :: Either a b -> Bool
isError (Left _) = True
isError _ = False

terminalError :: Either R2Error a -> Bool
terminalError (Left R2MultipartTerminal) = True
terminalError _ = False

-- Cursor iteration remains bounded and verifies the cursor advances before
-- following it. Include flags are explicit so metadata survives listing.
listing :: R2Bucket -> IO Value
listing bucket = do
  let keys = ["listing/a", "listing/b", "listing/c"]
  mapM_ (\key -> store bucket key "listed") (keys <> ["unrelated/a"])
  (pages, items) <- collect Nothing [] 0 []
  r2DeleteMany bucket (R2KeyBatch "listing/a" ["listing/b", "listing/c", "unrelated/a"])
  remaining <- mapM (r2Head bucket) keys
  pure $ object
    [ "pages" .= pages
    , "objects" .= map (\meta -> object
        [ "key" .= r2ObjectMetaKey meta
        , "contentType" .= r2HttpMetadataContentType (r2ObjectMetaHttpMetadata meta)
        , "purpose" .= lookup "purpose" (r2ObjectMetaCustomMetadata meta)
        ]) items
    , "deleted" .= all isNothing remaining
    ]
  where
    collect cursor seen count accumulated
      | count >= (10 :: Int) = fail "R2 listing exceeded fixture page bound"
      | otherwise = do
          page <- r2List bucket r2ListDefaultOptions
            { r2ListOptionsPrefix = Just "listing/"
            , r2ListOptionsCursor = cursor
            , r2ListOptionsLimit = Just 1
            , r2ListOptionsIncludeHttpMetadata = True
            , r2ListOptionsIncludeCustomMetadata = True
            }
          let objects = accumulated <> r2ListResultObjects page
          if not (r2ListResultTruncated page) then pure (count + 1, objects)
          else case r2ListResultCursor page of
            Nothing -> fail "Truncated R2 page has no cursor"
            Just next | next `elem` seen -> fail "R2 cursor failed to advance"
            Just next -> collect (Just next) (next : seen) (count + 1) objects

-- Body readers consume native streams: obtain a fresh object for each format.
-- Blob is deliberately opaque; roundtrip it through put instead of inspecting
-- a JS handle or pretending its bytes have been statically checked.
readers :: R2Bucket -> IO Value
readers bucket = flip finally cleanup $ do
  _ <- r2Put bucket "readers/source" (R2PutText "{\"enabled\":true}") r2PutDefaultOptions
  original <- fresh "readers/source"
  before <- r2ObjectBodyUsed original
  text <- r2ObjectText original
  after <- r2ObjectBodyUsed original
  json <- fresh "readers/source" >>= r2ObjectJSON
  array <- fresh "readers/source" >>= r2ObjectArrayBuffer
  blob <- fresh "readers/source" >>= r2ObjectBlob
  _ <- r2Put bucket "readers/blob" (R2PutBlob blob) r2PutDefaultOptions
  copied <- fresh "readers/blob" >>= r2ObjectBytes
  -- R2 requires a known-length stream. A native R2 object body retains that
  -- length, whereas an arbitrary producer stream does not.
  source <- fresh "readers/source"
  _ <- r2Put bucket "readers/stream" (R2PutStream (r2ObjectBody source)) r2PutDefaultOptions
  streamed <- fresh "readers/stream" >>= r2ObjectText
  _ <- r2Put bucket "readers/empty" R2PutNull r2PutDefaultOptions
  empty <- fresh "readers/empty" >>= r2ObjectBytes
  pure $ object ["text" .= text, "json" .= json, "arrayEqualsBlob" .= (array == copied)
    , "unusedBefore" .= not before, "usedAfter" .= after
    , "stream" .= streamed, "empty" .= Bytes.null empty]
 where
  fresh key = r2Get bucket key r2GetDefaultOptions >>= \case
    R2GetSuccess result -> pure result
    _ -> fail "R2 reader object missing"
  cleanup = r2DeleteMany bucket (R2KeyBatch "readers/source" ["readers/blob", "readers/stream", "readers/empty"])

-- Conditional updates implement optimistic concurrency. A failed update must
-- leave the previous bytes intact, including when checksum validation rejects it.
writeOptions :: R2Bucket -> IO Value
writeOptions bucket = flip finally (r2DeleteMany bucket (R2KeyBatch "options/value" ["options/checksum"])) $ do
  initial <- store bucket "options/value" "original"
  let options = r2PutDefaultOptions
        { r2ExtendedPutOnlyIf = Just (R2OnlyIfConditional (R2Condition (Just (r2ObjectMetaETag initial)) Nothing Nothing Nothing))
        , r2ExtendedPutStorageClass = Just R2Standard
        }
  accepted <- r2Put bucket "options/value" (R2PutText "updated") options
  rejected <- r2Put bucket "options/value" (R2PutText "stale") options
  unchanged <- r2Get bucket "options/value" r2GetDefaultOptions >>= body
  pure $ object ["accepted" .= stored accepted, "staleRejected" .= precondition rejected
    , "unchanged" .= (unchanged == "updated")]
 where
  stored (R2PutStored _) = True
  stored _ = False
  precondition R2PutPreconditionFailed = True
  precondition _ = False

-- Fixed known vectors verify every checksum option, rather than accepting the
-- presence of an option as evidence that native validation ran.
checksums :: R2Bucket -> IO Value
checksums bucket = do
  verified <- mapM check vectors
  pure (object ["verified" .= verified])
 where
  check (name, checksum, select) = flip finally (r2Delete bucket ("checksums/" <> name)) $ do
    result <- r2Put bucket ("checksums/" <> name) (R2PutText "payload") r2PutDefaultOptions
      { r2ExtendedPutChecksum = Just checksum }
    case result of
      R2PutStored meta -> pure (object ["algorithm" .= name, "recorded" .= (select (r2ObjectMetaChecksums meta) == Just (digest checksum))])
      _ -> fail "Checksum put unexpectedly rejected"
  digest (R2ChecksumMd5 bytes) = bytes
  digest (R2ChecksumSha1 bytes) = bytes
  digest (R2ChecksumSha256 bytes) = bytes
  digest (R2ChecksumSha384 bytes) = bytes
  digest (R2ChecksumSha512 bytes) = bytes
  vectors :: [(Text, R2ChecksumOption, R2Checksums -> Maybe Bytes.ByteString)]
  vectors =
    [ ("md5", R2ChecksumMd5 (Bytes.pack [50, 28, 60, 244, 134, 237, 80, 145, 100, 237, 236, 30, 25, 129, 254, 200]), r2ChecksumsMd5)
    , ("sha1", R2ChecksumSha1 (Bytes.pack [240, 126, 90, 129, 86, 19, 197, 171, 237, 220, 75, 104, 34, 71, 164, 196, 45, 138, 149, 223]), r2ChecksumsSha1)
    , ("sha256", R2ChecksumSha256 (Bytes.pack [35, 159, 89, 237, 85, 231, 55, 199, 113, 71, 207, 85, 173, 12, 27, 3, 11, 109, 126, 231, 72, 167, 66, 105, 82, 249, 184, 82, 213, 169, 53, 229]), r2ChecksumsSha256)
    , ("sha384", R2ChecksumSha384 (Bytes.pack [21, 112, 44, 133, 106, 23, 53, 170, 193, 201, 87, 9, 19, 9, 81, 199, 49, 229, 226, 6, 62, 133, 51, 206, 118, 216, 212, 106, 223, 224, 122, 225, 245, 215, 190, 119, 198, 19, 241, 40, 147, 254, 40, 151, 24, 255, 202, 43]), r2ChecksumsSha384)
    , ("sha512", R2ChecksumSha512 (Bytes.pack [112, 179, 60, 233, 201, 4, 126, 48, 249, 23, 231, 234, 19, 228, 47, 119, 103, 0, 140, 63, 79, 156, 155, 175, 73, 228, 57, 15, 198, 37, 84, 158, 150, 37, 238, 227, 155, 148, 84, 80, 116, 232, 161, 130, 76, 243, 242, 56, 70, 59, 17, 188, 3, 217, 115, 72, 224, 252, 41, 153, 202, 31, 255, 127]), r2ChecksumsSha512)
    ]

-- Delimiter browsing groups folders while startAfter supports stable key-based
-- continuation. Date conditions use UTC epoch milliseconds at wide boundaries.
browseOptions :: R2Bucket -> IO Value
browseOptions bucket = flip finally cleanup $ do
  let metadata = r2HttpMetadataDefault
        { r2HttpMetadataContentType = Just "text/plain"
        , r2HttpMetadataContentLanguage = Just "en"
        , r2HttpMetadataContentDisposition = Just "attachment"
        , r2HttpMetadataContentEncoding = Just "identity"
        , r2HttpMetadataCacheControl = Just "private, max-age=60"
        , r2HttpMetadataCacheExpiry = Just 4102444800000
        }
  mapM_ (\key -> r2Put bucket key (R2PutText "guide") r2PutDefaultOptions
    { r2ExtendedPutHttpMetadata = metadata }) keys
  grouped <- r2List bucket r2ListDefaultOptions
    { r2ListOptionsPrefix = Just "browse/", r2ListOptionsDelimiter = Just "/" }
  after <- r2List bucket r2ListDefaultOptions
    { r2ListOptionsPrefix = Just "browse/", r2ListOptionsStartAfter = Just "browse/a"
    , r2ListOptionsIncludeHttpMetadata = True }
  beforeFuture <- r2Get bucket "browse/a" (dated (Just 4102444800000) Nothing) >>= body
  afterPast <- r2Get bucket "browse/a" (dated Nothing (Just 0)) >>= body
  beforePast <- r2Get bucket "browse/a" (dated (Just 0) Nothing)
  afterFuture <- r2Get bucket "browse/a" (dated Nothing (Just 4102444800000))
  pure $ object ["objects" .= map r2ObjectMetaKey (r2ListResultObjects grouped)
    , "folders" .= r2ListResultDelimitedPrefixes grouped
    , "after" .= map r2ObjectMetaKey (r2ListResultObjects after)
    , "metadataPreserved" .= all ((== metadata) . r2ObjectMetaHttpMetadata) (r2ListResultObjects after)
    , "beforeFuture" .= (beforeFuture == "guide"), "afterPast" .= (afterPast == "guide")
    , "beforePastRejected" .= noBody beforePast, "afterFutureRejected" .= noBody afterFuture]
 where
  keys = ["browse/a", "browse/b", "browse/folder/c"]
  cleanup = r2DeleteMany bucket (R2KeyBatch "browse/a" ["browse/b", "browse/folder/c"])
  dated before after = r2GetDefaultOptions
    { r2GetOptionsOnlyIf = Just (R2OnlyIfConditional (R2Condition Nothing Nothing before after)) }
  noBody (R2GetPreconditionFailed _) = True
  noBody _ = False

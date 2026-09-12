module Cloudflare.Workers.Binding.R2 (
    R2Bucket (..),
    R2Error (..),
    R2HttpMetadata (..),
    r2HttpMetadataDefault,
    R2Checksums (..),
    R2StorageClass (..),
    R2PutValue (..),
    R2OnlyIf (..),
    R2ChecksumOption (..),
    R2SsecKey,
    mkR2SsecKey,
    R2PutOptions (..),
    r2PutDefaultOptions,
    R2PutResult (..),
    R2GetOptions (..),
    r2GetDefaultOptions,
    R2KeyBatch (..),
    r2KeyBatchCount,
    r2KeyBatchIsValid,
    R2ListOptions (..),
    r2ListDefaultOptions,
    R2ObjectMeta (..),
    R2Object (..),
    R2Blob,
    R2Range (..),
    R2Condition (..),
    R2GetResult (..),
    R2ListResult (..),
    R2MultipartOptions (..),
    r2MultipartDefaultOptions,
    R2MultipartUpload,
    r2MultipartUploadKey,
    r2MultipartUploadIdentifier,
    R2UploadedPart (..),
    r2Put,
    r2Head,
    r2Delete,
    r2DeleteMany,
    r2Get,
    r2List,
    r2ObjectBodyUsed,
    r2ObjectArrayBuffer,
    r2ObjectBytes,
    r2ObjectText,
    r2ObjectJSON,
    r2ObjectBlob,
    r2ObjectWriteHttpMetadata,
    r2CreateMultipartUpload,
    r2ResumeMultipartUpload,
    r2UploadPart,
    r2CompleteMultipartUpload,
    r2AbortMultipartUpload,
) where

import Control.Exception (Exception, throwIO)
import Data.ByteString (ByteString)
import Data.ByteString qualified as ByteString
import Data.ByteString.Lazy qualified as LazyByteString
import Data.IORef (IORef, atomicModifyIORef', newIORef, readIORef, writeIORef)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Headers (Headers)
import Cloudflare.Workers.Internal.FFI.R2 (
    R2ChecksumOptionViaFFI (..),
    R2ChecksumsViaFFI (..),
    R2ConditionViaFFI,
    R2GetOutcomeViaFFI (R2GetNotFoundViaFFI, R2GetPreconditionFailedViaFFI, R2GetSuccessViaFFI),
    R2HttpMetadataViaFFI (..),
    R2MultipartOptionsViaFFI (R2MultipartOptionsViaFFI),
    R2ObjectMetaViaFFI (..),
    R2OnlyIfViaFFI (..),
    R2PutOptionsViaFFI (R2PutOptionsViaFFI),
    R2PutValueViaFFI (..),
    R2RangeViaFFI (..),
    r2AbortMultipartUploadViaFFI,
    r2CompleteMultipartUploadViaFFI,
    r2CreateMultipartUploadViaFFI,
    r2DeleteManyViaFFI,
    r2DeleteViaFFI,
    r2GetViaFFI,
    r2HeadViaFFI,
    r2ListViaFFI,
    r2ObjectArrayBufferViaFFI,
    r2ObjectBlobViaFFI,
    r2ObjectBodyUsedViaFFI,
    r2ObjectBytesViaFFI,
    r2ObjectJSONViaFFI,
    r2ObjectTextViaFFI,
    r2ObjectWriteHttpMetadataViaFFI,
    r2PutViaFFI,
    r2ResumeMultipartUploadViaFFI,
    r2UploadPartViaFFI,
 )
import Cloudflare.Workers.Streaming (
    ReadableStream,
    ReadableStreamReadError,
    readableStreamFromJSVal,
    readableStreamToJSVal,
    readableStreamToLazyByteString,
 )

data R2Error
    = R2PutFailed Text
    | R2HeadFailed Text
    | R2DeleteFailed Text
    | R2GetFailed Text
    | R2ListFailed Text
    | R2MultipartFailed Text
    | R2MultipartTerminal
    deriving stock (Show, Eq)

instance Exception R2Error

newtype R2Bucket = R2Bucket JSVal

data R2HttpMetadata = R2HttpMetadata
    { r2HttpMetadataContentType :: Maybe Text
    , r2HttpMetadataContentLanguage :: Maybe Text
    , r2HttpMetadataContentDisposition :: Maybe Text
    , r2HttpMetadataContentEncoding :: Maybe Text
    , r2HttpMetadataCacheControl :: Maybe Text
    , r2HttpMetadataCacheExpiry :: Maybe Integer
    }
    deriving stock (Show, Eq)

r2HttpMetadataDefault :: R2HttpMetadata
r2HttpMetadataDefault = R2HttpMetadata Nothing Nothing Nothing Nothing Nothing Nothing

data R2Checksums = R2Checksums
    { r2ChecksumsMd5 :: Maybe ByteString
    , r2ChecksumsSha1 :: Maybe ByteString
    , r2ChecksumsSha256 :: Maybe ByteString
    , r2ChecksumsSha384 :: Maybe ByteString
    , r2ChecksumsSha512 :: Maybe ByteString
    }
    deriving stock (Show, Eq)

data R2StorageClass = R2Standard | R2InfrequentAccess | R2OtherStorageClass Text
    deriving stock (Show, Eq)

data R2PutValue
    = R2PutText Text
    | R2PutBytes ByteString
    | R2PutStream ReadableStream
    | R2PutNull
    | R2PutBlob R2Blob

data R2OnlyIf
    = R2OnlyIfHeaders Headers
    | R2OnlyIfConditional R2Condition
    deriving stock (Show, Eq)

data R2ChecksumOption
    = R2ChecksumMd5 ByteString
    | R2ChecksumSha1 ByteString
    | R2ChecksumSha256 ByteString
    | R2ChecksumSha384 ByteString
    | R2ChecksumSha512 ByteString
    deriving stock (Show, Eq)

newtype R2SsecKey = R2SsecKey ByteString
    deriving stock (Show, Eq)

mkR2SsecKey :: ByteString -> Maybe R2SsecKey
mkR2SsecKey bytes
    | ByteString.length bytes == 32 = Just (R2SsecKey bytes)
    | otherwise = Nothing

data R2PutOptions = R2PutOptions
    { r2ExtendedPutHttpMetadata :: R2HttpMetadata
    , r2ExtendedPutCustomMetadata :: [(Text, Text)]
    , r2ExtendedPutOnlyIf :: Maybe R2OnlyIf
    , r2ExtendedPutChecksum :: Maybe R2ChecksumOption
    , r2ExtendedPutStorageClass :: Maybe R2StorageClass
    , r2ExtendedPutSsecKey :: Maybe R2SsecKey
    }
    deriving stock (Show, Eq)

r2PutDefaultOptions :: R2PutOptions
r2PutDefaultOptions =
    R2PutOptions r2HttpMetadataDefault [] Nothing Nothing Nothing Nothing

data R2PutResult = R2PutPreconditionFailed | R2PutStored R2ObjectMeta
    deriving stock (Show, Eq)

data R2GetOptions = R2GetOptions
    { r2GetOptionsRange :: Maybe R2Range
    , r2GetOptionsOnlyIf :: Maybe R2OnlyIf
    , r2GetOptionsSsecKey :: Maybe R2SsecKey
    }
    deriving stock (Show, Eq)

r2GetDefaultOptions :: R2GetOptions
r2GetDefaultOptions = R2GetOptions Nothing Nothing Nothing

data R2KeyBatch = R2KeyBatch
    { r2KeyBatchFirst :: Text
    , r2KeyBatchRest :: [Text]
    }
    deriving stock (Show, Eq)

r2KeyBatchCount :: R2KeyBatch -> Int
r2KeyBatchCount batch = 1 + length (r2KeyBatchRest batch)

r2KeyBatchIsValid :: R2KeyBatch -> Bool
r2KeyBatchIsValid batch = r2KeyBatchCount batch <= 1000

data R2ListOptions = R2ListOptions
    { r2ListOptionsPrefix :: Maybe Text
    , r2ListOptionsCursor :: Maybe Text
    , r2ListOptionsLimit :: Maybe Int
    , r2ListOptionsDelimiter :: Maybe Text
    , r2ListOptionsStartAfter :: Maybe Text
    , r2ListOptionsIncludeHttpMetadata :: Bool
    , r2ListOptionsIncludeCustomMetadata :: Bool
    }
    deriving stock (Show, Eq)

r2ListDefaultOptions :: R2ListOptions
r2ListDefaultOptions = R2ListOptions Nothing Nothing Nothing Nothing Nothing False False

data R2ObjectMeta = R2ObjectMeta
    { r2ObjectMetaKey :: Text
    , r2ObjectMetaVersion :: Text
    , r2ObjectMetaSize :: Integer
    , r2ObjectMetaETag :: Text
    , r2ObjectMetaHttpETag :: Text
    , r2ObjectMetaChecksums :: R2Checksums
    , r2ObjectMetaUploaded :: Integer
    , r2ObjectMetaHttpMetadata :: R2HttpMetadata
    , r2ObjectMetaCustomMetadata :: [(Text, Text)]
    , r2ObjectMetaRange :: Maybe R2Range
    , r2ObjectMetaStorageClass :: R2StorageClass
    , r2ObjectMetaSsecKeyMd5 :: Maybe Text
    }
    deriving stock (Show, Eq)

data R2Object = R2Object
    { r2ObjectMeta :: R2ObjectMeta
    , r2ObjectBody :: ReadableStream
    , r2ObjectHandle :: JSVal
    , r2ObjectBodyReader :: Int -> IO (Either ReadableStreamReadError LazyByteString.ByteString)
    }

newtype R2Blob = R2Blob JSVal

data R2Range
    = R2RangeOffsetLength Integer Integer
    | R2RangeOffset Integer
    | R2RangeLength Integer
    | R2RangeSuffix Integer
    deriving stock (Show, Eq)

data R2Condition = R2Condition (Maybe Text) (Maybe Text) (Maybe Integer) (Maybe Integer)
    deriving stock (Show, Eq)

data R2GetResult
    = R2GetNotFound
    | R2GetPreconditionFailed R2ObjectMeta
    | R2GetSuccess R2Object

data R2ListResult = R2ListResult
    { r2ListResultObjects :: [R2ObjectMeta]
    , r2ListResultTruncated :: Bool
    , r2ListResultCursor :: Maybe Text
    , r2ListResultDelimitedPrefixes :: [Text]
    }
    deriving stock (Show, Eq)

data R2MultipartOptions = R2MultipartOptions
    { r2MultipartHttpMetadata :: R2HttpMetadata
    , r2MultipartCustomMetadata :: [(Text, Text)]
    , r2MultipartStorageClass :: Maybe R2StorageClass
    , r2MultipartSsecKey :: Maybe R2SsecKey
    }
    deriving stock (Show, Eq)

r2MultipartDefaultOptions :: R2MultipartOptions
r2MultipartDefaultOptions = R2MultipartOptions r2HttpMetadataDefault [] Nothing Nothing

data R2MultipartUpload = R2MultipartUpload
    { r2MultipartUploadHandle :: JSVal
    , r2MultipartUploadKey :: Text
    , r2MultipartUploadIdentifier :: Text
    , r2MultipartUploadActive :: IORef Bool
    }

data R2UploadedPart = R2UploadedPart
    { r2UploadedPartNumber :: Int
    , r2UploadedPartEtag :: Text
    }
    deriving stock (Show, Eq)

r2Put :: R2Bucket -> Text -> R2PutValue -> R2PutOptions -> IO R2PutResult
r2Put (R2Bucket bucketJSVal) key value options = do
    outcome <- r2PutViaFFI bucketJSVal key (toR2PutValueViaFFI value) (toR2PutOptionsViaFFI options)
    either (throwIO . R2PutFailed) (pure . maybe R2PutPreconditionFailed (R2PutStored . toR2ObjectMeta)) outcome

r2Head :: R2Bucket -> Text -> IO (Maybe R2ObjectMeta)
r2Head (R2Bucket bucketJSVal) key = do
    outcome <- r2HeadViaFFI bucketJSVal key
    either (throwIO . R2HeadFailed) (pure . fmap toR2ObjectMeta) outcome

r2Delete :: R2Bucket -> Text -> IO ()
r2Delete (R2Bucket bucketJSVal) key = do
    outcome <- r2DeleteViaFFI bucketJSVal key
    either (throwIO . R2DeleteFailed) pure outcome

r2DeleteMany :: R2Bucket -> R2KeyBatch -> IO ()
r2DeleteMany (R2Bucket bucketJSVal) batch
    | not (r2KeyBatchIsValid batch) = throwIO (R2DeleteFailed "R2 delete accepts at most 1000 keys")
    | otherwise = do
        outcome <- r2DeleteManyViaFFI bucketJSVal (r2KeyBatchFirst batch : r2KeyBatchRest batch)
        either (throwIO . R2DeleteFailed) pure outcome

r2Get :: R2Bucket -> Text -> R2GetOptions -> IO R2GetResult
r2Get (R2Bucket bucketJSVal) key options = do
    outcome <-
        r2GetViaFFI
            bucketJSVal
            key
            (fmap toR2RangeViaFFI (r2GetOptionsRange options))
            (fmap toR2OnlyIfViaFFI (r2GetOptionsOnlyIf options))
            (fmap unwrapSsecKey (r2GetOptionsSsecKey options))
    either (throwIO . R2GetFailed) (pure . fromOutcome) outcome
  where
    fromOutcome R2GetNotFoundViaFFI = R2GetNotFound
    fromOutcome (R2GetPreconditionFailedViaFFI rawMeta) = R2GetPreconditionFailed (toR2ObjectMeta rawMeta)
    fromOutcome (R2GetSuccessViaFFI rawMeta rawBodyJSVal rawObjectJSVal) =
        R2GetSuccess
            R2Object
                { r2ObjectMeta = toR2ObjectMeta rawMeta
                , r2ObjectBody = readableStreamFromJSVal rawBodyJSVal
                , r2ObjectHandle = rawObjectJSVal
                , r2ObjectBodyReader = \byteLimit -> readableStreamToLazyByteString byteLimit (readableStreamFromJSVal rawBodyJSVal)
                }

r2List :: R2Bucket -> R2ListOptions -> IO R2ListResult
r2List (R2Bucket bucketJSVal) options = do
    outcome <-
        r2ListViaFFI
            bucketJSVal
            (r2ListOptionsPrefix options)
            (r2ListOptionsCursor options)
            (r2ListOptionsLimit options)
            (r2ListOptionsDelimiter options)
            (r2ListOptionsStartAfter options)
            (r2ListOptionsIncludeHttpMetadata options)
            (r2ListOptionsIncludeCustomMetadata options)
    either (throwIO . R2ListFailed) (pure . toListResult) outcome
  where
    toListResult (rawObjects, truncated, cursor, delimitedPrefixes) =
        R2ListResult (fmap toR2ObjectMeta rawObjects) truncated cursor delimitedPrefixes

r2ObjectBodyUsed :: R2Object -> IO Bool
r2ObjectBodyUsed = r2ObjectBodyUsedViaFFI . r2ObjectHandle

r2ObjectArrayBuffer :: R2Object -> IO ByteString
r2ObjectArrayBuffer object = bodyOutcome R2GetFailed =<< r2ObjectArrayBufferViaFFI (r2ObjectHandle object)

r2ObjectBytes :: R2Object -> IO ByteString
r2ObjectBytes object = bodyOutcome R2GetFailed =<< r2ObjectBytesViaFFI (r2ObjectHandle object)

r2ObjectText :: R2Object -> IO Text
r2ObjectText object = bodyOutcome R2GetFailed =<< r2ObjectTextViaFFI (r2ObjectHandle object)

r2ObjectJSON :: R2Object -> IO Text
r2ObjectJSON object = bodyOutcome R2GetFailed =<< r2ObjectJSONViaFFI (r2ObjectHandle object)

r2ObjectBlob :: R2Object -> IO R2Blob
r2ObjectBlob object = R2Blob <$> (bodyOutcome R2GetFailed =<< r2ObjectBlobViaFFI (r2ObjectHandle object))

r2ObjectWriteHttpMetadata :: R2Object -> Headers -> IO Headers
r2ObjectWriteHttpMetadata object = r2ObjectWriteHttpMetadataViaFFI (r2ObjectHandle object)

r2CreateMultipartUpload :: R2Bucket -> Text -> R2MultipartOptions -> IO R2MultipartUpload
r2CreateMultipartUpload (R2Bucket bucketJSVal) key options = do
    outcome <- r2CreateMultipartUploadViaFFI bucketJSVal key (toMultipartOptionsViaFFI options)
    either (throwIO . R2MultipartFailed) makeUpload outcome

r2ResumeMultipartUpload :: R2Bucket -> Text -> Text -> IO R2MultipartUpload
r2ResumeMultipartUpload (R2Bucket bucketJSVal) key uploadIdentifier =
    makeUpload =<< r2ResumeMultipartUploadViaFFI bucketJSVal key uploadIdentifier

r2UploadPart :: R2MultipartUpload -> Int -> R2PutValue -> Maybe R2SsecKey -> IO R2UploadedPart
r2UploadPart upload partNumber value maybeSsecKey = do
    ensureMultipartActive upload
    outcome <-
        r2UploadPartViaFFI
            (r2MultipartUploadHandle upload)
            partNumber
            (toR2PutValueViaFFI value)
            (fmap unwrapSsecKey maybeSsecKey)
    either (throwIO . R2MultipartFailed) (pure . uncurry R2UploadedPart) outcome

r2CompleteMultipartUpload :: R2MultipartUpload -> [R2UploadedPart] -> IO R2ObjectMeta
r2CompleteMultipartUpload upload parts = do
    claimMultipartTerminal upload
    outcome <-
        r2CompleteMultipartUploadViaFFI
            (r2MultipartUploadHandle upload)
            (fmap (\part -> (r2UploadedPartNumber part, r2UploadedPartEtag part)) parts)
    case outcome of
        Left information -> do
            writeIORef (r2MultipartUploadActive upload) True
            throwIO (R2MultipartFailed information)
        Right meta -> pure (toR2ObjectMeta meta)

r2AbortMultipartUpload :: R2MultipartUpload -> IO ()
r2AbortMultipartUpload upload = do
    claimMultipartTerminal upload
    outcome <- r2AbortMultipartUploadViaFFI (r2MultipartUploadHandle upload)
    case outcome of
        Left information -> do
            writeIORef (r2MultipartUploadActive upload) True
            throwIO (R2MultipartFailed information)
        Right () -> pure ()

bodyOutcome :: (Text -> R2Error) -> Either Text a -> IO a
bodyOutcome constructor = either (throwIO . constructor) pure

makeUpload :: (JSVal, Text, Text) -> IO R2MultipartUpload
makeUpload (handle, key, uploadIdentifier) = do
    active <- newIORef True
    pure (R2MultipartUpload handle key uploadIdentifier active)

ensureMultipartActive :: R2MultipartUpload -> IO ()
ensureMultipartActive upload = do
    active <- readIORef (r2MultipartUploadActive upload)
    if active then pure () else throwIO R2MultipartTerminal

claimMultipartTerminal :: R2MultipartUpload -> IO ()
claimMultipartTerminal upload = do
    wasActive <- atomicModifyIORef' (r2MultipartUploadActive upload) consumeActive
    if wasActive then pure () else throwIO R2MultipartTerminal
  where
    consumeActive active = (False, active)

toR2HttpMetadataViaFFI :: R2HttpMetadata -> R2HttpMetadataViaFFI
toR2HttpMetadataViaFFI httpMetadata =
    R2HttpMetadataViaFFI
        (r2HttpMetadataContentType httpMetadata)
        (r2HttpMetadataContentLanguage httpMetadata)
        (r2HttpMetadataContentDisposition httpMetadata)
        (r2HttpMetadataContentEncoding httpMetadata)
        (r2HttpMetadataCacheControl httpMetadata)
        (r2HttpMetadataCacheExpiry httpMetadata)

fromR2HttpMetadataViaFFI :: R2HttpMetadataViaFFI -> R2HttpMetadata
fromR2HttpMetadataViaFFI metadata =
    R2HttpMetadata
        (r2HttpContentTypeViaFFI metadata)
        (r2HttpContentLanguageViaFFI metadata)
        (r2HttpContentDispositionViaFFI metadata)
        (r2HttpContentEncodingViaFFI metadata)
        (r2HttpCacheControlViaFFI metadata)
        (r2HttpCacheExpiryMillisecondsViaFFI metadata)

toR2ObjectMeta :: R2ObjectMetaViaFFI -> R2ObjectMeta
toR2ObjectMeta rawMeta =
    R2ObjectMeta
        { r2ObjectMetaKey = r2ObjectKeyViaFFI rawMeta
        , r2ObjectMetaVersion = r2ObjectVersionViaFFI rawMeta
        , r2ObjectMetaSize = r2ObjectSizeViaFFI rawMeta
        , r2ObjectMetaETag = r2ObjectEtagViaFFI rawMeta
        , r2ObjectMetaHttpETag = r2ObjectHttpEtagViaFFI rawMeta
        , r2ObjectMetaChecksums = fromR2ChecksumsViaFFI (r2ObjectChecksumsViaFFI rawMeta)
        , r2ObjectMetaUploaded = r2ObjectUploadedMillisecondsViaFFI rawMeta
        , r2ObjectMetaHttpMetadata = fromR2HttpMetadataViaFFI (r2ObjectHttpMetadataViaFFI rawMeta)
        , r2ObjectMetaCustomMetadata = r2ObjectCustomMetadataViaFFI rawMeta
        , r2ObjectMetaRange = fmap fromR2RangeViaFFI (r2ObjectRangeViaFFI rawMeta)
        , r2ObjectMetaStorageClass = storageClassFromText (r2ObjectStorageClassViaFFI rawMeta)
        , r2ObjectMetaSsecKeyMd5 = r2ObjectSsecKeyMd5ViaFFI rawMeta
        }

fromR2ChecksumsViaFFI :: R2ChecksumsViaFFI -> R2Checksums
fromR2ChecksumsViaFFI checksums =
    R2Checksums
        (r2ChecksumMd5ViaFFI checksums)
        (r2ChecksumSha1ViaFFI checksums)
        (r2ChecksumSha256ViaFFI checksums)
        (r2ChecksumSha384ViaFFI checksums)
        (r2ChecksumSha512ViaFFI checksums)

fromR2RangeViaFFI :: R2RangeViaFFI -> R2Range
fromR2RangeViaFFI (R2RangeOffsetLengthViaFFI offset rangeLength) = R2RangeOffsetLength offset rangeLength
fromR2RangeViaFFI (R2RangeOffsetViaFFI offset) = R2RangeOffset offset
fromR2RangeViaFFI (R2RangeLengthViaFFI rangeLength) = R2RangeLength rangeLength
fromR2RangeViaFFI (R2RangeSuffixViaFFI suffix) = R2RangeSuffix suffix

storageClassFromText :: Text -> R2StorageClass
storageClassFromText "Standard" = R2Standard
storageClassFromText "InfrequentAccess" = R2InfrequentAccess
storageClassFromText value = R2OtherStorageClass value

toR2RangeViaFFI :: R2Range -> R2RangeViaFFI
toR2RangeViaFFI (R2RangeOffsetLength offset rangeLength) = R2RangeOffsetLengthViaFFI offset rangeLength
toR2RangeViaFFI (R2RangeOffset offset) = R2RangeOffsetViaFFI offset
toR2RangeViaFFI (R2RangeLength rangeLength) = R2RangeLengthViaFFI rangeLength
toR2RangeViaFFI (R2RangeSuffix suffix) = R2RangeSuffixViaFFI suffix

toR2ConditionViaFFI :: R2Condition -> R2ConditionViaFFI
toR2ConditionViaFFI (R2Condition etagMatches etagDoesNotMatch uploadedBefore uploadedAfter) =
    (etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter)

toR2PutValueViaFFI :: R2PutValue -> R2PutValueViaFFI
toR2PutValueViaFFI (R2PutText value) = R2PutTextViaFFI value
toR2PutValueViaFFI (R2PutBytes value) = R2PutBytesViaFFI value
toR2PutValueViaFFI (R2PutStream value) = R2PutStreamViaFFI (readableStreamToJSVal value)
toR2PutValueViaFFI R2PutNull = R2PutNullViaFFI
toR2PutValueViaFFI (R2PutBlob (R2Blob value)) = R2PutBlobViaFFI value

toR2OnlyIfViaFFI :: R2OnlyIf -> R2OnlyIfViaFFI
toR2OnlyIfViaFFI (R2OnlyIfHeaders headers) = R2OnlyIfHeadersViaFFI headers
toR2OnlyIfViaFFI (R2OnlyIfConditional condition) = R2OnlyIfConditionalViaFFI (toR2ConditionViaFFI condition)

toChecksumOptionViaFFI :: R2ChecksumOption -> R2ChecksumOptionViaFFI
toChecksumOptionViaFFI (R2ChecksumMd5 value) = R2ChecksumMd5ViaFFI value
toChecksumOptionViaFFI (R2ChecksumSha1 value) = R2ChecksumSha1ViaFFI value
toChecksumOptionViaFFI (R2ChecksumSha256 value) = R2ChecksumSha256ViaFFI value
toChecksumOptionViaFFI (R2ChecksumSha384 value) = R2ChecksumSha384ViaFFI value
toChecksumOptionViaFFI (R2ChecksumSha512 value) = R2ChecksumSha512ViaFFI value

toR2PutOptionsViaFFI :: R2PutOptions -> R2PutOptionsViaFFI
toR2PutOptionsViaFFI options =
    R2PutOptionsViaFFI
        (toR2HttpMetadataViaFFI (r2ExtendedPutHttpMetadata options))
        (r2ExtendedPutCustomMetadata options)
        (fmap toR2OnlyIfViaFFI (r2ExtendedPutOnlyIf options))
        (fmap toChecksumOptionViaFFI (r2ExtendedPutChecksum options))
        (fmap storageClassToText (r2ExtendedPutStorageClass options))
        (fmap unwrapSsecKey (r2ExtendedPutSsecKey options))

toMultipartOptionsViaFFI :: R2MultipartOptions -> R2MultipartOptionsViaFFI
toMultipartOptionsViaFFI options =
    R2MultipartOptionsViaFFI
        (toR2HttpMetadataViaFFI (r2MultipartHttpMetadata options))
        (r2MultipartCustomMetadata options)
        (fmap storageClassToText (r2MultipartStorageClass options))
        (fmap unwrapSsecKey (r2MultipartSsecKey options))

storageClassToText :: R2StorageClass -> Text
storageClassToText R2Standard = "Standard"
storageClassToText R2InfrequentAccess = "InfrequentAccess"
storageClassToText (R2OtherStorageClass value) = value

unwrapSsecKey :: R2SsecKey -> ByteString
unwrapSsecKey (R2SsecKey value) = value

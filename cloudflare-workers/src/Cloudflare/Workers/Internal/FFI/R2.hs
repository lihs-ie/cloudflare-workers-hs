module Cloudflare.Workers.Internal.FFI.R2 (
    R2HttpMetadataViaFFI (..),
    r2HttpMetadataViaFFIDefault,
    R2ChecksumsViaFFI (..),
    R2ObjectMetaViaFFI (..),
    R2RangeViaFFI (..),
    r2RangeComponentToJSNumber,
    R2ConditionViaFFI,
    R2GetOutcomeViaFFI (..),
    R2PutValueViaFFI (..),
    R2OnlyIfViaFFI (..),
    R2ChecksumOptionViaFFI (..),
    R2PutOptionsViaFFI (..),
    R2MultipartOptionsViaFFI (..),
    r2PutViaFFI,
    r2GetViaFFI,
    r2ObjectBodyUsedViaFFI,
    r2ObjectArrayBufferViaFFI,
    r2ObjectBytesViaFFI,
    r2ObjectTextViaFFI,
    r2ObjectJSONViaFFI,
    r2ObjectBlobViaFFI,
    r2ObjectWriteHttpMetadataViaFFI,
    r2CreateMultipartUploadViaFFI,
    r2ResumeMultipartUploadViaFFI,
    r2UploadPartViaFFI,
    r2CompleteMultipartUploadViaFFI,
    r2AbortMultipartUploadViaFFI,
    r2HeadViaFFI,
    r2DeleteViaFFI,
    r2DeleteManyViaFFI,
    r2ListViaFFI,
    decodeR2ObjectMeta,
    encodeR2Condition,
    encodeR2HttpMetadata,
    encodeR2Range,
) where

import Control.Monad (forM, when, (<=<), (>=>))
import Data.ByteString (ByteString)
import Data.Foldable (for_)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Headers (Headers)
import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Headers (headersFromJSVal, headersToJSVal)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Internal.R2Range (r2RangeComponentToJSNumber)

data R2HttpMetadataViaFFI = R2HttpMetadataViaFFI
    { r2HttpContentTypeViaFFI :: Maybe Text
    , r2HttpContentLanguageViaFFI :: Maybe Text
    , r2HttpContentDispositionViaFFI :: Maybe Text
    , r2HttpContentEncodingViaFFI :: Maybe Text
    , r2HttpCacheControlViaFFI :: Maybe Text
    , r2HttpCacheExpiryMillisecondsViaFFI :: Maybe Integer
    }
    deriving stock (Show, Eq)

r2HttpMetadataViaFFIDefault :: R2HttpMetadataViaFFI
r2HttpMetadataViaFFIDefault = R2HttpMetadataViaFFI Nothing Nothing Nothing Nothing Nothing Nothing

data R2ChecksumsViaFFI = R2ChecksumsViaFFI
    { r2ChecksumMd5ViaFFI :: Maybe ByteString
    , r2ChecksumSha1ViaFFI :: Maybe ByteString
    , r2ChecksumSha256ViaFFI :: Maybe ByteString
    , r2ChecksumSha384ViaFFI :: Maybe ByteString
    , r2ChecksumSha512ViaFFI :: Maybe ByteString
    }
    deriving stock (Show, Eq)

data R2ObjectMetaViaFFI = R2ObjectMetaViaFFI
    { r2ObjectKeyViaFFI :: Text
    , r2ObjectVersionViaFFI :: Text
    , r2ObjectSizeViaFFI :: Integer
    , r2ObjectEtagViaFFI :: Text
    , r2ObjectHttpEtagViaFFI :: Text
    , r2ObjectChecksumsViaFFI :: R2ChecksumsViaFFI
    , r2ObjectUploadedMillisecondsViaFFI :: Integer
    , r2ObjectHttpMetadataViaFFI :: R2HttpMetadataViaFFI
    , r2ObjectCustomMetadataViaFFI :: [(Text, Text)]
    , r2ObjectRangeViaFFI :: Maybe R2RangeViaFFI
    , r2ObjectStorageClassViaFFI :: Text
    , r2ObjectSsecKeyMd5ViaFFI :: Maybe Text
    }
    deriving stock (Show, Eq)

data R2RangeViaFFI
    = R2RangeOffsetLengthViaFFI Integer Integer
    | R2RangeOffsetViaFFI Integer
    | R2RangeLengthViaFFI Integer
    | R2RangeSuffixViaFFI Integer
    deriving stock (Show, Eq)

type R2ConditionViaFFI = (Maybe Text, Maybe Text, Maybe Integer, Maybe Integer)

data R2GetOutcomeViaFFI
    = R2GetNotFoundViaFFI
    | R2GetPreconditionFailedViaFFI R2ObjectMetaViaFFI
    | R2GetSuccessViaFFI R2ObjectMetaViaFFI JSVal JSVal

encodeR2HttpMetadata :: R2HttpMetadataViaFFI -> IO JSVal
encodeR2HttpMetadata metadata = do
    httpMetadataJSVal <- jsEmptyObject
    for_ (r2HttpContentTypeViaFFI metadata) (setTextFieldVia jsSetHttpMetadataContentType httpMetadataJSVal)
    for_ (r2HttpContentLanguageViaFFI metadata) (setTextFieldVia jsSetHttpMetadataContentLanguage httpMetadataJSVal)
    for_ (r2HttpContentDispositionViaFFI metadata) (setTextFieldVia jsSetHttpMetadataContentDisposition httpMetadataJSVal)
    for_ (r2HttpContentEncodingViaFFI metadata) (setTextFieldVia jsSetHttpMetadataContentEncoding httpMetadataJSVal)
    for_ (r2HttpCacheControlViaFFI metadata) (setTextFieldVia jsSetHttpMetadataCacheControl httpMetadataJSVal)
    for_ (r2HttpCacheExpiryMillisecondsViaFFI metadata) (jsSetHttpMetadataCacheExpiry httpMetadataJSVal . fromInteger)
    pure httpMetadataJSVal
  where
    setTextFieldVia setter targetJSVal textValue = textToJSVal textValue >>= setter targetJSVal

r2HeadViaFFI :: JSVal -> Text -> IO (Either Text (Maybe R2ObjectMetaViaFFI))
r2HeadViaFFI bucketJSVal key = do
    keyJSVal <- textToJSVal key
    decodeEnveloped decodeHeadResult =<< jsR2HeadEnveloped bucketJSVal keyJSVal
  where
    decodeHeadResult resultJSVal = do
        isNull <- jsIsNullish resultJSVal
        if isNull then pure Nothing else Just <$> decodeR2ObjectMeta resultJSVal

r2DeleteViaFFI :: JSVal -> Text -> IO (Either Text ())
r2DeleteViaFFI bucketJSVal key = do
    keyJSVal <- textToJSVal key
    decodeEnveloped (const (pure ())) =<< jsR2DeleteEnveloped bucketJSVal keyJSVal

r2DeleteManyViaFFI :: JSVal -> [Text] -> IO (Either Text ())
r2DeleteManyViaFFI bucketJSVal keys = do
    keysJSVal <- jsEmptyArray
    for_ keys (textToJSVal >=> jsArrayPush keysJSVal)
    decodeEnveloped (const (pure ())) =<< jsR2DeleteEnveloped bucketJSVal keysJSVal

encodeR2Range :: R2RangeViaFFI -> IO (Either Text JSVal)
encodeR2Range (R2RangeOffsetLengthViaFFI offset rangeLength) =
    case (,) <$> r2RangeComponentToJSNumber "offset" offset <*> r2RangeComponentToJSNumber "length" rangeLength of
        Left failureMessage -> pure (Left failureMessage)
        Right (offsetNumber, rangeLengthNumber) -> do
            rangeJSVal <- jsEmptyObject
            jsSetRangeOffset rangeJSVal offsetNumber
            jsSetRangeLength rangeJSVal rangeLengthNumber
            pure (Right rangeJSVal)
encodeR2Range (R2RangeOffsetViaFFI offset) =
    case r2RangeComponentToJSNumber "offset" offset of
        Left failureMessage -> pure (Left failureMessage)
        Right offsetNumber -> do
            rangeJSVal <- jsEmptyObject
            jsSetRangeOffset rangeJSVal offsetNumber
            pure (Right rangeJSVal)
encodeR2Range (R2RangeLengthViaFFI rangeLength) =
    case r2RangeComponentToJSNumber "length" rangeLength of
        Left failureMessage -> pure (Left failureMessage)
        Right rangeLengthNumber -> do
            rangeJSVal <- jsEmptyObject
            jsSetRangeLength rangeJSVal rangeLengthNumber
            pure (Right rangeJSVal)
encodeR2Range (R2RangeSuffixViaFFI suffix) =
    case r2RangeComponentToJSNumber "suffix" suffix of
        Left failureMessage -> pure (Left failureMessage)
        Right suffixNumber -> do
            rangeJSVal <- jsEmptyObject
            jsSetRangeSuffix rangeJSVal suffixNumber
            pure (Right rangeJSVal)

encodeR2Condition :: R2ConditionViaFFI -> IO JSVal
encodeR2Condition (etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter) = do
    conditionJSVal <- jsEmptyObject
    for_ etagMatches (textToJSVal >=> jsSetConditionEtagMatches conditionJSVal)
    for_ etagDoesNotMatch (textToJSVal >=> jsSetConditionEtagDoesNotMatch conditionJSVal)
    for_ uploadedBefore (jsSetConditionUploadedBeforeMillis conditionJSVal . fromInteger)
    for_ uploadedAfter (jsSetConditionUploadedAfterMillis conditionJSVal . fromInteger)
    pure conditionJSVal

r2ListViaFFI ::
    JSVal ->
    Maybe Text ->
    Maybe Text ->
    Maybe Int ->
    Maybe Text ->
    Maybe Text ->
    Bool ->
    Bool ->
    IO (Either Text ([R2ObjectMetaViaFFI], Bool, Maybe Text, [Text]))
r2ListViaFFI bucketJSVal maybePrefix maybeCursor maybeLimit maybeDelimiter maybeStartAfter includeHttpMetadata includeCustomMetadata = do
    optionsJSVal <- jsEmptyObject
    for_ maybeDelimiter (textToJSVal >=> jsSetListOptionDelimiter optionsJSVal)
    for_ maybePrefix (textToJSVal >=> jsSetListOptionPrefix optionsJSVal)
    for_ maybeCursor (textToJSVal >=> jsSetListOptionCursor optionsJSVal)
    for_ maybeLimit (jsSetListOptionLimit optionsJSVal)
    for_ maybeStartAfter (textToJSVal >=> jsSetListOptionStartAfter optionsJSVal)
    includeJSVal <- jsEmptyArray
    when includeHttpMetadata $ textToJSVal "httpMetadata" >>= jsArrayPush includeJSVal
    when includeCustomMetadata $ textToJSVal "customMetadata" >>= jsArrayPush includeJSVal
    when (includeHttpMetadata || includeCustomMetadata) $ jsSetListOptionInclude optionsJSVal includeJSVal
    decodeEnveloped decodeListResult =<< jsR2ListEnveloped bucketJSVal optionsJSVal
  where
    decodeListResult resultJSVal = do
        objectsArrayJSVal <- jsR2ListResultObjectsField resultJSVal
        objectCount <- jsArrayLength objectsArrayJSVal
        objects <- forM [0 .. objectCount - 1] (decodeR2ObjectMeta <=< jsArrayIndex objectsArrayJSVal)
        truncated <- jsR2ListResultTruncatedField resultJSVal
        hasCursor <- jsR2ListResultHasCursor resultJSVal
        cursor <- if hasCursor then Just <$> (jsR2ListResultCursorField resultJSVal >>= jsValToText) else pure Nothing
        delimitedPrefixesArrayJSVal <- jsR2ListResultDelimitedPrefixesField resultJSVal
        delimitedPrefixCount <- jsArrayLength delimitedPrefixesArrayJSVal
        delimitedPrefixes <-
            forM [0 .. delimitedPrefixCount - 1] (jsValToText <=< jsArrayIndex delimitedPrefixesArrayJSVal)
        pure (objects, truncated, cursor, delimitedPrefixes)

decodeR2ObjectMeta :: JSVal -> IO R2ObjectMetaViaFFI
decodeR2ObjectMeta objectJSVal = do
    key <- jsR2ObjectKeyField objectJSVal >>= jsValToText
    version <- jsR2ObjectVersionField objectJSVal >>= jsValToText
    size <- round <$> jsR2ObjectSizeField objectJSVal
    etag <- jsR2ObjectETagField objectJSVal >>= jsValToText
    httpEtag <- jsR2ObjectHttpETagField objectJSVal >>= jsValToText
    checksums <- decodeR2Checksums =<< jsR2ObjectChecksumsField objectJSVal
    uploadedMillis <- round <$> jsR2ObjectUploadedMillisField objectJSVal
    httpMetadataObjectJSVal <- jsR2ObjectHttpMetadataField objectJSVal
    isHttpMetadataNullish <- jsIsNullish httpMetadataObjectJSVal
    httpMetadata <-
        if isHttpMetadataNullish then pure r2HttpMetadataViaFFIDefault else decodeR2HttpMetadata httpMetadataObjectJSVal
    customMetadataObjectJSVal <- jsR2ObjectCustomMetadataField objectJSVal
    isCustomMetadataNullish <- jsIsNullish customMetadataObjectJSVal
    customMetadata <- if isCustomMetadataNullish then pure [] else decodeCustomMetadata customMetadataObjectJSVal
    range <- decodeOptionalRange =<< jsR2ObjectRangeField objectJSVal
    storageClass <- jsR2ObjectStorageClassField objectJSVal >>= jsValToText
    ssecKeyMd5 <- readOptionalText =<< jsR2ObjectSsecKeyMd5OrNull objectJSVal
    pure
        R2ObjectMetaViaFFI
            { r2ObjectKeyViaFFI = key
            , r2ObjectVersionViaFFI = version
            , r2ObjectSizeViaFFI = size
            , r2ObjectEtagViaFFI = etag
            , r2ObjectHttpEtagViaFFI = httpEtag
            , r2ObjectChecksumsViaFFI = checksums
            , r2ObjectUploadedMillisecondsViaFFI = uploadedMillis
            , r2ObjectHttpMetadataViaFFI = httpMetadata
            , r2ObjectCustomMetadataViaFFI = customMetadata
            , r2ObjectRangeViaFFI = range
            , r2ObjectStorageClassViaFFI = storageClass
            , r2ObjectSsecKeyMd5ViaFFI = ssecKeyMd5
            }

decodeR2HttpMetadata :: JSVal -> IO R2HttpMetadataViaFFI
decodeR2HttpMetadata httpMetadataJSVal = do
    contentType <- readOptionalTextField jsHttpMetadataContentTypeOrNull
    contentLanguage <- readOptionalTextField jsHttpMetadataContentLanguageOrNull
    contentDisposition <- readOptionalTextField jsHttpMetadataContentDispositionOrNull
    contentEncoding <- readOptionalTextField jsHttpMetadataContentEncodingOrNull
    cacheControl <- readOptionalTextField jsHttpMetadataCacheControlOrNull
    cacheExpiryRaw <- jsHttpMetadataCacheExpiryMillisOrMissing httpMetadataJSVal
    let cacheExpiry = if cacheExpiryRaw < 0 then Nothing else Just (round cacheExpiryRaw)
    pure (R2HttpMetadataViaFFI contentType contentLanguage contentDisposition contentEncoding cacheControl cacheExpiry)
  where
    readOptionalTextField reader = do
        rawJSVal <- reader httpMetadataJSVal
        isNull <- jsIsNullish rawJSVal
        if isNull then pure Nothing else Just <$> jsValToText rawJSVal

decodeR2Checksums :: JSVal -> IO R2ChecksumsViaFFI
decodeR2Checksums checksumsJSVal =
    R2ChecksumsViaFFI
        <$> decodeChecksum jsR2ChecksumMd5Field checksumsJSVal
        <*> decodeChecksum jsR2ChecksumSha1Field checksumsJSVal
        <*> decodeChecksum jsR2ChecksumSha256Field checksumsJSVal
        <*> decodeChecksum jsR2ChecksumSha384Field checksumsJSVal
        <*> decodeChecksum jsR2ChecksumSha512Field checksumsJSVal
  where
    decodeChecksum reader ownerJSVal = do
        valueJSVal <- reader ownerJSVal
        isNull <- jsIsNullish valueJSVal
        if isNull
            then pure Nothing
            else Just <$> (jsWrapArrayBufferAsUint8Array valueJSVal >>= jsByteArrayToByteString)

decodeOptionalRange :: JSVal -> IO (Maybe R2RangeViaFFI)
decodeOptionalRange rangeJSVal = do
    isNull <- jsIsNullish rangeJSVal
    if isNull
        then pure Nothing
        else do
            tag <- jsR2RangeTag rangeJSVal
            case tag of
                1 -> do
                    first <- round <$> jsR2RangeFirstNumber rangeJSVal
                    Just . R2RangeOffsetLengthViaFFI first . round <$> jsR2RangeSecondNumber rangeJSVal
                2 -> Just . R2RangeOffsetViaFFI . round <$> jsR2RangeFirstNumber rangeJSVal
                3 -> Just . R2RangeLengthViaFFI . round <$> jsR2RangeFirstNumber rangeJSVal
                4 -> Just . R2RangeSuffixViaFFI . round <$> jsR2RangeFirstNumber rangeJSVal
                _ -> pure Nothing

readOptionalText :: JSVal -> IO (Maybe Text)
readOptionalText valueJSVal = do
    isNull <- jsIsNullish valueJSVal
    if isNull then pure Nothing else Just <$> jsValToText valueJSVal

decodeCustomMetadata :: JSVal -> IO [(Text, Text)]
decodeCustomMetadata customMetadataJSVal = do
    keysJSVal <- jsObjectKeys customMetadataJSVal
    keyCount <- jsArrayLength keysJSVal
    forM [0 .. keyCount - 1] $ \index -> do
        keyJSVal <- jsArrayIndex keysJSVal index
        keyText <- jsValToText keyJSVal
        valueText <- jsObjectGet customMetadataJSVal keyJSVal >>= jsValToText
        pure (keyText, valueText)

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.head($2)
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsR2HeadEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        await $1.delete($2);
        return {
          ok: true,
          value: null
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsR2DeleteEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.list($2)
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsR2ListEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.key"
    jsR2ObjectKeyField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.version"
    jsR2ObjectVersionField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const objectSize = $1.size;
      if (!Number.isFinite(objectSize)) {
        throw new TypeError('the R2 object size field is not a finite number: ' + typeof objectSize);
      }
      return objectSize;
    })()
    """
    jsR2ObjectSizeField :: JSVal -> IO Double

foreign import javascript unsafe "$1.etag"
    jsR2ObjectETagField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.httpEtag"
    jsR2ObjectHttpETagField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.checksums"
    jsR2ObjectChecksumsField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const uploadedMillis = $1.uploaded?.getTime?.();
      if (!Number.isFinite(uploadedMillis)) {
        throw new TypeError('the R2 object uploaded timestamp is not a finite number: ' + typeof uploadedMillis);
      }
      return uploadedMillis;
    })()
    """
    jsR2ObjectUploadedMillisField :: JSVal -> IO Double

foreign import javascript unsafe "$1.httpMetadata"
    jsR2ObjectHttpMetadataField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.customMetadata"
    jsR2ObjectCustomMetadataField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.range"
    jsR2ObjectRangeField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.storageClass"
    jsR2ObjectStorageClassField :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.ssecKeyMd5 === 'string' ? $1.ssecKeyMd5 : null"
    jsR2ObjectSsecKeyMd5OrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.contentType === 'string' ? $1.contentType : null"
    jsHttpMetadataContentTypeOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.contentLanguage === 'string' ? $1.contentLanguage : null"
    jsHttpMetadataContentLanguageOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.contentDisposition === 'string' ? $1.contentDisposition : null"
    jsHttpMetadataContentDispositionOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.contentEncoding === 'string' ? $1.contentEncoding : null"
    jsHttpMetadataContentEncodingOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "typeof $1.cacheControl === 'string' ? $1.cacheControl : null"
    jsHttpMetadataCacheControlOrNull :: JSVal -> IO JSVal

foreign import javascript unsafe "(() => { const expiry = $1.cacheExpiry; if (expiry === undefined || expiry === null) return -1; const value = expiry.getTime(); if (!Number.isFinite(value) || value < 0) throw new TypeError('invalid R2 cacheExpiry'); return value; })()"
    jsHttpMetadataCacheExpiryMillisOrMissing :: JSVal -> IO Double

foreign import javascript unsafe "$1.md5"
    jsR2ChecksumMd5Field :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.sha1"
    jsR2ChecksumSha1Field :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.sha256"
    jsR2ChecksumSha256Field :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.sha384"
    jsR2ChecksumSha384Field :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.sha512"
    jsR2ChecksumSha512Field :: JSVal -> IO JSVal

foreign import javascript unsafe "(() => { const present = (key) => $1[key] !== undefined && $1[key] !== null; return present('suffix') ? 4 : ((present('offset') && present('length')) ? 1 : (present('offset') ? 2 : (present('length') ? 3 : 0))); })()"
    jsR2RangeTag :: JSVal -> IO Int

foreign import javascript unsafe "(() => { const present = (key) => $1[key] !== undefined && $1[key] !== null; const value = present('suffix') ? $1.suffix : (present('offset') ? $1.offset : $1.length); if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid R2 range component'); return value; })()"
    jsR2RangeFirstNumber :: JSVal -> IO Double

foreign import javascript unsafe "(() => { const value = $1.length; if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid R2 range length'); return value; })()"
    jsR2RangeSecondNumber :: JSVal -> IO Double

foreign import javascript unsafe "$1.contentType = $2"
    jsSetHttpMetadataContentType :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.contentLanguage = $2"
    jsSetHttpMetadataContentLanguage :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.contentDisposition = $2"
    jsSetHttpMetadataContentDisposition :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.contentEncoding = $2"
    jsSetHttpMetadataContentEncoding :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.cacheControl = $2"
    jsSetHttpMetadataCacheControl :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.cacheExpiry = new Date($2)"
    jsSetHttpMetadataCacheExpiry :: JSVal -> Double -> IO ()

foreign import javascript unsafe "$1.offset = $2"
    jsSetRangeOffset :: JSVal -> Double -> IO ()

foreign import javascript unsafe "$1.length = $2"
    jsSetRangeLength :: JSVal -> Double -> IO ()

foreign import javascript unsafe "$1.suffix = $2"
    jsSetRangeSuffix :: JSVal -> Double -> IO ()

foreign import javascript unsafe "$1.etagMatches = $2"
    jsSetConditionEtagMatches :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.etagDoesNotMatch = $2"
    jsSetConditionEtagDoesNotMatch :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.uploadedBefore = new Date($2)"
    jsSetConditionUploadedBeforeMillis :: JSVal -> Double -> IO ()

foreign import javascript unsafe "$1.uploadedAfter = new Date($2)"
    jsSetConditionUploadedAfterMillis :: JSVal -> Double -> IO ()

foreign import javascript unsafe "$1.delimiter = $2"
    jsSetListOptionDelimiter :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.prefix = $2"
    jsSetListOptionPrefix :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.cursor = $2"
    jsSetListOptionCursor :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.limit = $2"
    jsSetListOptionLimit :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.startAfter = $2"
    jsSetListOptionStartAfter :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.include = $2"
    jsSetListOptionInclude :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.objects"
    jsR2ListResultObjectsField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const truncatedFlag = $1.truncated;
      if (truncatedFlag === true) {
        return true;
      }
      if (truncatedFlag === false) {
        return false;
      }
      throw new TypeError('the R2 list truncated field is not a boolean: ' + typeof truncatedFlag);
    })()
    """
    jsR2ListResultTruncatedField :: JSVal -> IO Bool

foreign import javascript unsafe "typeof $1.cursor === 'string'"
    jsR2ListResultHasCursor :: JSVal -> IO Bool

foreign import javascript unsafe "$1.cursor"
    jsR2ListResultCursorField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.delimitedPrefixes"
    jsR2ListResultDelimitedPrefixesField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1 === null || $1 === undefined"
    jsIsNullish :: JSVal -> IO Bool

foreign import javascript unsafe "new Uint8Array($1)"
    jsWrapArrayBufferAsUint8Array :: JSVal -> IO JSVal

foreign import javascript unsafe "({})"
    jsEmptyObject :: IO JSVal

foreign import javascript unsafe "[]"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push($2)"
    jsArrayPush :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "Object.keys($1)"
    jsObjectKeys :: JSVal -> IO JSVal

foreign import javascript unsafe "$1[$2]"
    jsObjectGet :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const sourceArray = $1;
      if (!Array.isArray(sourceArray)) {
        throw new TypeError('the R2 array this decoder was handed is not a JS Array: ' + typeof sourceArray);
      }
      const elementCount = sourceArray.length;
      if (!Number.isSafeInteger(elementCount) || elementCount < 0 || elementCount > 2147483647) {
        throw new RangeError('the R2 array this decoder was handed has a length no 32-bit Haskell Int can carry');
      }
      return elementCount;
    })()
    """
    jsArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsArrayIndex :: JSVal -> Int -> IO JSVal

data R2PutValueViaFFI
    = R2PutTextViaFFI Text
    | R2PutBytesViaFFI ByteString
    | R2PutStreamViaFFI JSVal
    | R2PutNullViaFFI
    | R2PutBlobViaFFI JSVal

data R2OnlyIfViaFFI
    = R2OnlyIfConditionalViaFFI R2ConditionViaFFI
    | R2OnlyIfHeadersViaFFI Headers

data R2ChecksumOptionViaFFI
    = R2ChecksumMd5ViaFFI ByteString
    | R2ChecksumSha1ViaFFI ByteString
    | R2ChecksumSha256ViaFFI ByteString
    | R2ChecksumSha384ViaFFI ByteString
    | R2ChecksumSha512ViaFFI ByteString

data R2PutOptionsViaFFI = R2PutOptionsViaFFI
    { r2ExtendedPutHttpMetadataViaFFI :: R2HttpMetadataViaFFI
    , r2ExtendedPutCustomMetadataViaFFI :: [(Text, Text)]
    , r2ExtendedPutOnlyIfViaFFI :: Maybe R2OnlyIfViaFFI
    , r2ExtendedPutChecksumViaFFI :: Maybe R2ChecksumOptionViaFFI
    , r2ExtendedPutStorageClassViaFFI :: Maybe Text
    , r2ExtendedPutSsecKeyViaFFI :: Maybe ByteString
    }

data R2MultipartOptionsViaFFI = R2MultipartOptionsViaFFI
    { r2MultipartHttpMetadataViaFFI :: R2HttpMetadataViaFFI
    , r2MultipartCustomMetadataViaFFI :: [(Text, Text)]
    , r2MultipartStorageClassViaFFI :: Maybe Text
    , r2MultipartSsecKeyViaFFI :: Maybe ByteString
    }

r2PutViaFFI ::
    JSVal -> Text -> R2PutValueViaFFI -> R2PutOptionsViaFFI -> IO (Either Text (Maybe R2ObjectMetaViaFFI))
r2PutViaFFI bucketJSVal key value options = do
    keyJSVal <- textToJSVal key
    valueJSVal <- encodePutValue value
    optionsJSVal <- encodeExtendedOptions options
    decodeEnveloped decodeResult =<< jsR2PutEnveloped bucketJSVal keyJSVal valueJSVal optionsJSVal
  where
    decodeResult objectJSVal = do
        isNull <- jsIsNullish objectJSVal
        if isNull then pure Nothing else Just <$> decodeR2ObjectMeta objectJSVal

r2GetViaFFI ::
    JSVal -> Text -> Maybe R2RangeViaFFI -> Maybe R2OnlyIfViaFFI -> Maybe ByteString -> IO (Either Text R2GetOutcomeViaFFI)
r2GetViaFFI bucketJSVal key maybeRange maybeOnlyIf maybeSsecKey = do
    keyJSVal <- textToJSVal key
    optionsJSVal <- jsEmptyObject
    rangeOutcome <- traverse encodeR2Range maybeRange
    case sequence rangeOutcome of
        Left message -> pure (Left message)
        Right encodedRange -> do
            for_ encodedRange (jsSetRange optionsJSVal)
            for_ maybeOnlyIf (encodeOnlyIf >=> jsSetOnlyIf optionsJSVal)
            for_ maybeSsecKey (byteStringToJSByteArray >=> jsSetSsecKey optionsJSVal)
            decodeEnveloped decodeGetResult =<< jsR2GetEnveloped bucketJSVal keyJSVal optionsJSVal
  where
    decodeGetResult objectJSVal = do
        isNull <- jsIsNullish objectJSVal
        if isNull
            then pure R2GetNotFoundViaFFI
            else do
                meta <- decodeR2ObjectMeta objectJSVal
                bodyJSVal <- jsObjectBody objectJSVal
                bodyMissing <- jsIsNullish bodyJSVal
                pure
                    ( if bodyMissing
                        then R2GetPreconditionFailedViaFFI meta
                        else R2GetSuccessViaFFI meta bodyJSVal objectJSVal
                    )

r2ObjectBodyUsedViaFFI :: JSVal -> IO Bool
r2ObjectBodyUsedViaFFI = jsR2BodyUsed

r2ObjectArrayBufferViaFFI :: JSVal -> IO (Either Text ByteString)
r2ObjectArrayBufferViaFFI objectJSVal =
    decodeEnveloped (jsByteArrayToByteString <=< jsWrapArrayBufferAsUint8Array) =<< jsR2ArrayBufferEnveloped objectJSVal

r2ObjectBytesViaFFI :: JSVal -> IO (Either Text ByteString)
r2ObjectBytesViaFFI objectJSVal = decodeEnveloped jsByteArrayToByteString =<< jsR2BytesEnveloped objectJSVal

r2ObjectTextViaFFI :: JSVal -> IO (Either Text Text)
r2ObjectTextViaFFI objectJSVal = decodeEnveloped jsValToText =<< jsR2TextEnveloped objectJSVal

r2ObjectJSONViaFFI :: JSVal -> IO (Either Text Text)
r2ObjectJSONViaFFI objectJSVal = decodeEnveloped (jsJSONStringify >=> jsValToText) =<< jsR2JSONEnveloped objectJSVal

r2ObjectBlobViaFFI :: JSVal -> IO (Either Text JSVal)
r2ObjectBlobViaFFI objectJSVal = decodeEnveloped pure =<< jsR2BlobEnveloped objectJSVal

r2ObjectWriteHttpMetadataViaFFI :: JSVal -> Headers -> IO Headers
r2ObjectWriteHttpMetadataViaFFI objectJSVal headers = do
    headersJSVal <- headersToJSVal headers
    jsR2WriteHttpMetadata objectJSVal headersJSVal
    headersFromJSVal headersJSVal

r2CreateMultipartUploadViaFFI ::
    JSVal -> Text -> R2MultipartOptionsViaFFI -> IO (Either Text (JSVal, Text, Text))
r2CreateMultipartUploadViaFFI bucketJSVal key options = do
    keyJSVal <- textToJSVal key
    optionsJSVal <- encodeMultipartOptions options
    decodeEnveloped decodeUpload =<< jsR2CreateMultipartEnveloped bucketJSVal keyJSVal optionsJSVal

r2ResumeMultipartUploadViaFFI :: JSVal -> Text -> Text -> IO (JSVal, Text, Text)
r2ResumeMultipartUploadViaFFI bucketJSVal key uploadIdentifier = do
    keyJSVal <- textToJSVal key
    uploadIdentifierJSVal <- textToJSVal uploadIdentifier
    uploadJSVal <- jsR2ResumeMultipart bucketJSVal keyJSVal uploadIdentifierJSVal
    decodeUpload uploadJSVal

r2UploadPartViaFFI :: JSVal -> Int -> R2PutValueViaFFI -> Maybe ByteString -> IO (Either Text (Int, Text))
r2UploadPartViaFFI uploadJSVal partNumber value maybeSsecKey = do
    valueJSVal <- encodePutValue value
    optionsJSVal <- jsEmptyObject
    for_ maybeSsecKey (byteStringToJSByteArray >=> jsSetSsecKey optionsJSVal)
    decodeEnveloped decodeUploadedPart =<< jsR2UploadPartEnveloped uploadJSVal partNumber valueJSVal optionsJSVal

r2CompleteMultipartUploadViaFFI :: JSVal -> [(Int, Text)] -> IO (Either Text R2ObjectMetaViaFFI)
r2CompleteMultipartUploadViaFFI uploadJSVal parts = do
    partsJSVal <- jsEmptyArray
    for_ parts $ \(partNumber, etag) -> do
        partJSVal <- jsEmptyObject
        jsSetPartNumber partJSVal partNumber
        textToJSVal etag >>= jsSetPartEtag partJSVal
        jsArrayPush partsJSVal partJSVal
    decodeEnveloped decodeR2ObjectMeta =<< jsR2CompleteMultipartEnveloped uploadJSVal partsJSVal

r2AbortMultipartUploadViaFFI :: JSVal -> IO (Either Text ())
r2AbortMultipartUploadViaFFI uploadJSVal =
    decodeEnveloped (const (pure ())) =<< jsR2AbortMultipartEnveloped uploadJSVal

encodePutValue :: R2PutValueViaFFI -> IO JSVal
encodePutValue (R2PutTextViaFFI value) = textToJSVal value
encodePutValue (R2PutBytesViaFFI value) = byteStringToJSByteArray value
encodePutValue (R2PutStreamViaFFI value) = pure value
encodePutValue R2PutNullViaFFI = jsNull
encodePutValue (R2PutBlobViaFFI value) = pure value

encodeExtendedOptions :: R2PutOptionsViaFFI -> IO JSVal
encodeExtendedOptions options = do
    optionsJSVal <- jsEmptyObject
    encodeR2HttpMetadata (r2ExtendedPutHttpMetadataViaFFI options) >>= jsSetHttpMetadata optionsJSVal
    encodeCustomMetadata (r2ExtendedPutCustomMetadataViaFFI options) >>= jsSetCustomMetadata optionsJSVal
    for_ (r2ExtendedPutOnlyIfViaFFI options) (encodeOnlyIf >=> jsSetOnlyIf optionsJSVal)
    for_ (r2ExtendedPutChecksumViaFFI options) (setChecksum optionsJSVal)
    for_ (r2ExtendedPutStorageClassViaFFI options) (textToJSVal >=> jsSetStorageClass optionsJSVal)
    for_ (r2ExtendedPutSsecKeyViaFFI options) (byteStringToJSByteArray >=> jsSetSsecKey optionsJSVal)
    pure optionsJSVal

encodeMultipartOptions :: R2MultipartOptionsViaFFI -> IO JSVal
encodeMultipartOptions options = do
    optionsJSVal <- jsEmptyObject
    encodeR2HttpMetadata (r2MultipartHttpMetadataViaFFI options) >>= jsSetHttpMetadata optionsJSVal
    encodeCustomMetadata (r2MultipartCustomMetadataViaFFI options) >>= jsSetCustomMetadata optionsJSVal
    for_ (r2MultipartStorageClassViaFFI options) (textToJSVal >=> jsSetStorageClass optionsJSVal)
    for_ (r2MultipartSsecKeyViaFFI options) (byteStringToJSByteArray >=> jsSetSsecKey optionsJSVal)
    pure optionsJSVal

encodeCustomMetadata :: [(Text, Text)] -> IO JSVal
encodeCustomMetadata entries = do
    objectJSVal <- jsEmptyObject
    for_ entries $ \(key, value) -> do
        keyJSVal <- textToJSVal key
        valueJSVal <- textToJSVal value
        jsSetDynamic objectJSVal keyJSVal valueJSVal
    pure objectJSVal

encodeOnlyIf :: R2OnlyIfViaFFI -> IO JSVal
encodeOnlyIf (R2OnlyIfConditionalViaFFI condition) = encodeR2Condition condition
encodeOnlyIf (R2OnlyIfHeadersViaFFI headers) = headersToJSVal headers

setChecksum :: JSVal -> R2ChecksumOptionViaFFI -> IO ()
setChecksum optionsJSVal checksum = do
    let (name, bytes) = case checksum of
            R2ChecksumMd5ViaFFI value -> ("md5", value)
            R2ChecksumSha1ViaFFI value -> ("sha1", value)
            R2ChecksumSha256ViaFFI value -> ("sha256", value)
            R2ChecksumSha384ViaFFI value -> ("sha384", value)
            R2ChecksumSha512ViaFFI value -> ("sha512", value)
    nameJSVal <- textToJSVal name
    valueJSVal <- byteStringToJSByteArray bytes
    jsSetDynamic optionsJSVal nameJSVal valueJSVal

decodeUpload :: JSVal -> IO (JSVal, Text, Text)
decodeUpload uploadJSVal = do
    key <- jsUploadKey uploadJSVal >>= jsValToText
    uploadIdentifier <- jsUploadIdentifier uploadJSVal >>= jsValToText
    pure (uploadJSVal, key, uploadIdentifier)

decodeUploadedPart :: JSVal -> IO (Int, Text)
decodeUploadedPart partJSVal = do
    partNumber <- jsUploadedPartNumber partJSVal
    etag <- jsUploadedPartEtag partJSVal >>= jsValToText
    pure (partNumber, etag)

foreign import javascript safe
    """
    (async () => { try { return { ok: true, value: await $1.put($2, $3, $4) }; }
      catch (error) { try { return { ok: false, message: String(error) }; }
        catch { return { ok: false, message: 'unstringifiable error' }; } } })()
    """
    jsR2PutEnveloped :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.get($2,$3)} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2GetEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "(() => { const value = $1.bodyUsed; if (value === true) return true; if (value === false) return false; throw new TypeError('invalid R2 bodyUsed'); })()"
    jsR2BodyUsed :: JSVal -> IO Bool

foreign import javascript unsafe "$1.body"
    jsObjectBody :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.writeHttpMetadata($2)"
    jsR2WriteHttpMetadata :: JSVal -> JSVal -> IO ()

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.arrayBuffer()} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2ArrayBufferEnveloped :: JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.bytes()} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2BytesEnveloped :: JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.text()} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2TextEnveloped :: JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.json()} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2JSONEnveloped :: JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.blob()} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2BlobEnveloped :: JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.createMultipartUpload($2,$3)} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2CreateMultipartEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "$1.resumeMultipartUpload($2, $3)"
    jsR2ResumeMultipart :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.uploadPart($2,$3,$4)} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2UploadPartEnveloped :: JSVal -> Int -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return {ok:true,value:await $1.complete($2)} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2CompleteMultipartEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { await $1.abort(); return {ok:true,value:null} } catch(error) { return {ok:false,message:String(error)} } })()"
    jsR2AbortMultipartEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "null"
    jsNull :: IO JSVal

foreign import javascript unsafe "JSON.stringify($1)"
    jsJSONStringify :: JSVal -> IO JSVal

foreign import javascript unsafe "$1[$2] = $3"
    jsSetDynamic :: JSVal -> JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.httpMetadata = $2"
    jsSetHttpMetadata :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.customMetadata = $2"
    jsSetCustomMetadata :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.onlyIf = $2"
    jsSetOnlyIf :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.range = $2"
    jsSetRange :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.storageClass = $2"
    jsSetStorageClass :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.ssecKey = $2"
    jsSetSsecKey :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.partNumber = $2"
    jsSetPartNumber :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.etag = $2"
    jsSetPartEtag :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe "$1.key"
    jsUploadKey :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.uploadId"
    jsUploadIdentifier :: JSVal -> IO JSVal

foreign import javascript unsafe "(() => { const value = $1.partNumber; if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError('invalid R2 multipart partNumber'); return value; })()"
    jsUploadedPartNumber :: JSVal -> IO Int

foreign import javascript unsafe "$1.etag"
    jsUploadedPartEtag :: JSVal -> IO JSVal

module Support.Runtime.StoragePublicContracts (storagePublicContractsProbe) where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Binding.DurableObject.SQL
import Cloudflare.Workers.Binding.KV
import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Binding.Workflow
import Cloudflare.Workers.Internal.FFI.D1 qualified as FFI
import Cloudflare.Workers.Internal.FFI.KV qualified as FFI
import Cloudflare.Workers.Internal.FFI.R2 qualified as FFI
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (Exception, displayException, throwIO, try)
import Data.Aeson (FromJSON (..), Options (..), ToJSON (..), Value, defaultOptions, eitherDecode, encode, genericParseJSON, genericToEncoding, genericToJSON, object, (.=))
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as Lazy
import Data.Either (fromLeft)
import Data.List (intercalate, nub)
import Data.Text (Text)
import Data.Text.Encoding qualified as Text
import GHC.Generics (Generic)
import GHC.Wasm.Prim (JSVal)

-- A consumer compares snapshots before updating persisted state. Its diagnostic
-- renderer must retain the suffix when embedded inside a larger report.
contract :: (Eq a, Show a) => String -> [a] -> Value
contract name values =
    object
        [ "name" .= name
        , "same" .= and [a == a && not (a /= a) | a <- values]
        , "changed" .= and [a /= b && not (a == b) | (a, b) <- zip values (drop 1 values)]
        , "batch" .= (showList values ";end" == "[" <> intercalate "," (map show values) <> "];end")
        , "embedded" .= and [shows a ";end" == show a <> ";end" | a <- values]
        , "diagnostic" .= showList values ""
        ]

-- Typed recovery verifies exception identity, payload preservation, and the
-- public diagnostic used when a failed batch is reported to its caller.
exceptionContract :: (Exception a, Eq a) => String -> [a] -> IO Value
exceptionContract name failures = do
    outcomes <-
        mapM
            ( \failure -> do
                outcome <- try (throwIO failure)
                pure (case outcome of Left actual -> actual == failure && displayException actual == show failure; Right (_ :: ()) -> False)
            )
            failures
    pure (object ["name" .= name, "recovered" .= and outcomes, "values" .= contract name failures])

storagePublicContractsProbe :: JSVal -> IO JSVal
storagePublicContractsProbe raw = do
    mode <- jsValToText raw
    result <- case mode of
        "snapshots" -> pure (object ["contracts" .= snapshots, "multipartDeduplicated" .= (nub [R2UploadedPart 1 "etag-a", R2UploadedPart 2 "etag-b", R2UploadedPart 1 "etag-a"] == [R2UploadedPart 1 "etag-a", R2UploadedPart 2 "etag-b"])])
        "json-contracts" -> pure jsonContracts
        "ssec-diagnostics" -> case (mkR2SsecKey (Bytes.replicate 32 0), mkR2SsecKey (Bytes.replicate 32 1)) of
            (Just first, Just second) -> pure (contract "synthetic R2SsecKey" [first, second])
            _ -> fail "Synthetic 32-byte key construction failed"
        "exceptions" ->
            object . (\xs -> ["exceptions" .= xs])
                <$> sequence
                    [ exceptionContract "D1ExecutionError" [D1ConstraintViolation "duplicate", D1SyntaxError "syntax", D1UnknownError "offline"]
                    , exceptionContract "D1DecodeError" [D1MissingColumn "name", D1UnexpectedNull "name", D1ColumnTypeMismatch "name" D1TextType D1BlobType, D1InvalidColumnValue "name" "empty"]
                    , exceptionContract "D1QueryError" [D1RowDecodeFailed 2 (D1MissingColumn "name"), D1InvalidParameter 1 "range", D1UnsuccessfulResult "select"]
                    , exceptionContract "KVError" [KVGetFailed "read", KVGetWithMetadataFailed "meta", KVPutFailed "write", KVDeleteFailed "delete", KVListFailed "list", KVBulkGetFailed "bulk", KVTooManyKeys 101, KVInvalidCacheTtl 29]
                    , exceptionContract "R2Error" [R2PutFailed "put", R2HeadFailed "head", R2DeleteFailed "delete", R2GetFailed "get", R2ListFailed "list", R2MultipartFailed "part", R2MultipartTerminal]
                    , exceptionContract "DurableObjectError" [DurableObjectInvalidIDString "bad", DurableObjectIDSerializationFailed "serialize", DurableObjectFetchFailed "fetch", DurableObjectRPCFailed "rpc", DurableObjectStorageFailed "storage"]
                    , exceptionContract "SQLError" [SQLError "row limit", SQLError "byte limit"]
                    , exceptionContract "WorkflowError" [WorkflowError "get" "missing", WorkflowError "sendEvent" "offline"]
                    , exceptionContract "WorkflowNonRetryableError" [WorkflowNonRetryableError "invalid order", WorkflowNonRetryableError "cancelled order"]
                    ]
        "ordering" ->
            pure $
                let
                    lower = WorkflowIdentifier "order-a"
                    middle = WorkflowIdentifier "order-b"
                    upper = WorkflowIdentifier "order-c"
                    inRange candidate = lower <= candidate && candidate <= upper && not (candidate < lower) && not (candidate > upper)
                 in
                    object ["contained" .= all inRange [lower, middle, upper], "strict" .= (lower < middle && upper > middle && upper >= middle), "compare" .= (compare lower upper == LT && compare upper lower == GT && compare middle middle == EQ), "endpoints" .= (min lower upper == lower && max lower upper == upper), "deduplicated" .= (nub [lower, middle, lower, upper] == [lower, middle, upper]), "contracts" .= [contract "WorkflowIdentifier" [lower, middle, upper]]]
        _ -> fail "Unknown storage public contract mode"
    textToJSVal (Text.decodeUtf8 (Lazy.toStrict (encode result)))

snapshots :: [Value]
snapshots =
    [ contract "D1ValueViaFFI" [FFI.D1NullViaFFI, FFI.D1IntegerViaFFI 7, FFI.D1RealViaFFI 1.25, FFI.D1TextViaFFI "row", FFI.D1BlobViaFFI "blob"]
    , contract "KVReadFormViaFFI" [FFI.KVReadTextViaFFI, FFI.KVReadJSONViaFFI, FFI.KVReadArrayBufferViaFFI, FFI.KVReadStreamViaFFI]
    , contract "KVBulkReadFormViaFFI" [FFI.KVBulkReadTextViaFFI, FFI.KVBulkReadJSONViaFFI]
    , contract "R2HttpMetadataViaFFI" [ffiHttp, ffiHttp{FFI.r2HttpContentTypeViaFFI = Just "text/plain"}]
    , contract "R2ChecksumsViaFFI" [ffiChecksums, ffiChecksums{FFI.r2ChecksumSha256ViaFFI = Just "digest"}]
    , contract "R2ObjectMetaViaFFI" [ffiObject, ffiObject{FFI.r2ObjectVersionViaFFI = "v2"}]
    , contract "R2RangeViaFFI" [FFI.R2RangeOffsetLengthViaFFI 0 4, FFI.R2RangeOffsetViaFFI 4, FFI.R2RangeLengthViaFFI 4, FFI.R2RangeSuffixViaFFI 4]
    , contract "D1Value" [D1Null, D1Integer 7, D1Real 1.25, D1Text "row", D1Blob "blob"]
    , contract "D1Meta" [meta, meta{d1MetaChanges = Just 2}]
    , contract "D1Result" [D1Result [[("name", D1Text "Ada")]] True meta, D1Result [] False meta]
    , contract "D1RunResult" [D1RunResult True meta, D1RunResult False meta]
    , contract "D1ExecResult" [D1ExecResult 1 0.5, D1ExecResult 2 0.5]
    , contract "D1Statement" [D1Statement "SELECT ?" [D1Integer 1], D1Statement "SELECT ?" [D1Integer 2]]
    , contract "D1ColumnType" [D1NullType, D1TextType, D1IntegerType, D1RealType, D1BlobType]
    , contract "KVReadType" [KVReadText, KVReadJSON, KVReadArrayBuffer, KVReadStream]
    , contract "KVBulkReadType" [KVBulkReadText, KVBulkReadJSON]
    , contract "KVReadOptions" [KVReadOptions Nothing, KVReadOptions (Just 30)]
    , contract "KVPutOptions" [kvPutDefaultOptions, KVPutOptions Nothing (Just 60) (Just "{}")]
    , contract "KVKeyBatch" [KVKeyBatch "a" ["b"], KVKeyBatch "b" ["a"]]
    , contract "KVListKey" [key, key{kvListKeyMetadata = Just "{}"}]
    , contract "KVListResult" [KVListResult [key] False (Just "next") Nothing, KVListResult [key] True Nothing (Just "HIT")]
    , contract "R2HttpMetadata" [r2HttpMetadataDefault, http]
    , contract "R2Checksums" [checksums, checksums{r2ChecksumsSha256 = Just "digest"}]
    , contract "R2StorageClass" [R2Standard, R2InfrequentAccess, R2OtherStorageClass "future"]
    , contract "R2ChecksumOption" [R2ChecksumMd5 "digest", R2ChecksumSha1 "digest", R2ChecksumSha256 "digest", R2ChecksumSha384 "digest", R2ChecksumSha512 "digest"]
    , contract "R2SsecKey" [mkR2SsecKey (Bytes.replicate 32 0), mkR2SsecKey (Bytes.replicate 32 1)]
    , contract "R2Condition" [condition, R2Condition Nothing (Just "etag") Nothing Nothing]
    , contract "R2OnlyIf" [R2OnlyIfConditional condition, R2OnlyIfConditional (R2Condition Nothing Nothing (Just 1) Nothing)]
    , contract "R2PutOptions" [r2PutDefaultOptions, r2PutDefaultOptions{r2ExtendedPutHttpMetadata = http}]
    , contract "R2GetOptions" [r2GetDefaultOptions, r2GetDefaultOptions{r2GetOptionsRange = Just (R2RangeSuffix 4)}]
    , contract "R2KeyBatch" [R2KeyBatch "a" ["b"], R2KeyBatch "b" ["a"]]
    , contract "R2ListOptions" [r2ListDefaultOptions, r2ListDefaultOptions{r2ListOptionsCursor = Just "next"}]
    , contract "R2ObjectMeta" [objectMeta, objectMeta{r2ObjectMetaVersion = "v2"}]
    , contract "R2PutResult" [R2PutStored objectMeta, R2PutPreconditionFailed]
    , contract "R2Range" [R2RangeOffsetLength 0 4, R2RangeOffset 4, R2RangeLength 4, R2RangeSuffix 4]
    , contract "R2ListResult" [R2ListResult [objectMeta] False Nothing [], R2ListResult [] True (Just "next") ["archive/"]]
    , contract "R2MultipartOptions" [r2MultipartDefaultOptions, r2MultipartDefaultOptions{r2MultipartHttpMetadata = http}]
    , contract "R2UploadedPart" [R2UploadedPart 1 "etag-a", R2UploadedPart 2 "etag-b"]
    , contract "DurableObjectStorageOperation" [DurableObjectStorageOperationPut "name" "Ada", DurableObjectStorageOperationDelete "name", DurableObjectStorageOperationFail]
    , contract "SQLValue" [SQLNull, SQLText "row", SQLNumber 1.25, SQLBlob "blob"]
    , contract "SQLStatement" [SQLStatement "SELECT ?" [SQLNumber 1], SQLStatement "SELECT ?" [SQLNumber 2]]
    , contract "SQLResult" [SQLResult ["name"] [[SQLText "Ada"]] 1 0, SQLResult ["name"] [] 0 0]
    , contract "SQLLimits" [sqlDefaultLimits, sqlDefaultLimits{maximumRows = 1}]
    , contract "WorkflowDuration" [WorkflowMilliseconds 1000, WorkflowMilliseconds 2000]
    , contract "WorkflowBackoff" [WorkflowConstant, WorkflowLinear, WorkflowExponential]
    , contract "WorkflowStepOptions" [defaultWorkflowStepOptions, defaultWorkflowStepOptions{workflowRetryLimit = 0}]
    , contract "WorkflowStepContext" [WorkflowStepContext "send" 1 1, WorkflowStepContext "send" 1 2]
    , contract "WorkflowState" [WorkflowQueued, WorkflowRunning, WorkflowPaused, WorkflowErrored, WorkflowTerminated, WorkflowComplete, WorkflowWaiting, WorkflowWaitingForPause, WorkflowUnknown "future"]
    , contract "WorkflowFailure" [WorkflowFailure "Timeout" "waiting", WorkflowFailure "Timeout" "exhausted"]
    , contract "WorkflowStatus" [WorkflowStatus WorkflowRunning (Nothing :: Maybe Int) Nothing, WorkflowStatus WorkflowComplete (Just 7) Nothing]
    , contract "WorkflowReceivedEvent" [WorkflowReceivedEvent (7 :: Int) "ready" "2026-09-12T00:00:00Z", WorkflowReceivedEvent 8 "ready" "2026-09-12T00:00:00Z"]
    ]
  where
    ffiHttp = FFI.R2HttpMetadataViaFFI Nothing Nothing Nothing Nothing Nothing Nothing
    ffiChecksums = FFI.R2ChecksumsViaFFI Nothing Nothing Nothing Nothing Nothing
    ffiObject = FFI.R2ObjectMetaViaFFI "report" "v1" 4 "etag" "etag" ffiChecksums 1 ffiHttp [] Nothing "Standard" Nothing
    meta = D1Meta 0.5 (Just 1) (Just 7) (Just 1) (Just 1)
    key = KVListKey "profile" Nothing Nothing
    http = r2HttpMetadataDefault{r2HttpMetadataContentType = Just "text/plain"}
    checksums = R2Checksums Nothing Nothing Nothing Nothing Nothing
    condition = R2Condition (Just "etag") Nothing Nothing Nothing
    objectMeta = R2ObjectMeta "report" "v1" 4 "etag" "\"etag\"" checksums 1 http [] Nothing R2Standard Nothing

-- Required payloads cannot silently disappear when generic omission is enabled.
-- This models a persisted job envelope, rather than calling default methods and
-- discarding their answers.
newtype Required a = Required {required :: a} deriving stock (Generic)
instance (ToJSON a) => ToJSON (Required a) where
    toJSON = genericToJSON defaultOptions{omitNothingFields = True}
    toEncoding = genericToEncoding defaultOptions{omitNothingFields = True}
instance (FromJSON a) => FromJSON (Required a) where
    parseJSON = genericParseJSON defaultOptions{allowOmittedFields = True}

requiredFieldContract :: forall a. (FromJSON a, Eq a, Show a) => String -> a -> Value -> Value
requiredFieldContract name expected encoded =
    object
        [ "name" .= name
        , "present"
            .= either
                (const False)
                (\envelope -> required envelope == expected)
                (eitherDecode (encode (object ["required" .= encoded])))
        , "missingDiagnostic"
            .= fromLeft
                "unexpected accepted omission"
                (eitherDecode "{}" :: Either String (Required a))
        ]

bulkContract :: forall a. (FromJSON a, Eq a) => String -> [a] -> [Value] -> Value
bulkContract name expected encoded =
    object
        [ "name" .= name
        , "matches" .= (eitherDecode (encode encoded) == Right expected)
        , "malformedDiagnostic"
            .= fromLeft
                "unexpected accepted member"
                (eitherDecode "[false]" :: Either String [a])
        ]

jsonContracts :: Value
jsonContracts =
    object
        [ "envelopeJSON" .= (toJSON (Required statement) == object ["required" .= toJSON statement])
        , "envelopeListJSON" .= (toJSON [Required statement] == toJSON [object ["required" .= toJSON statement]])
        , "envelopeListEncoding" .= (eitherDecode (encode [Required statement]) == Right (toJSON [Required statement]))
        , "nestedEncoding" .= (eitherDecode (encode (Required (Required statement))) == Right (object ["required" .= object ["required" .= toJSON statement]]))
        , "envelopeListDecode"
            .= either
                (const False)
                (\decoded -> map required decoded == [SQLText "row"])
                (eitherDecode (encode [object ["required" .= toJSON (SQLText "row")]]))
        , "nestedMissingDiagnostic"
            .= fromLeft
                "unexpected accepted nested omission"
                (eitherDecode "{}" :: Either String (Required (Required SQLValue)))
        , "rowsRead" .= rowsRead sqlResult
        , "scalar" .= (eitherDecode (encode (SQLText "row")) == Right (toJSON (SQLText "row")))
        , "values" .= (eitherDecode (encode sqlValues) == Right (map toJSON sqlValues))
        , "statements" .= (toJSON statements == toJSON (map toJSON statements))
        , "retainedValue" .= (eitherDecode (encode (Required (SQLText "row"))) == Right (object ["required" .= toJSON (SQLText "row")]))
        , "retainedStatement" .= (eitherDecode (encode (Required statement)) == Right (object ["required" .= toJSON statement]))
        , "required"
            .= [ requiredFieldContract "SQLValue" (SQLText "row") (toJSON (SQLText "row"))
               , requiredFieldContract "SQLResult" sqlResult sqlResultJSON
               , requiredFieldContract "WorkflowStepContext" context contextJSON
               , requiredFieldContract "WorkflowFailure" failure failureJSON
               , requiredFieldContract "WorkflowStatus" status statusJSON
               , requiredFieldContract "WorkflowReceivedEvent" event eventJSON
               ]
        , "bulk"
            .= [ bulkContract "WorkflowStepContext" [context, context{workflowStepAttempt = 2}] [contextJSON, object ["step" .= object ["name" .= ("send" :: Text), "count" .= (1 :: Int)], "attempt" .= (2 :: Int)]]
               , bulkContract "WorkflowFailure" [failure, WorkflowFailure "Timeout" "exhausted"] [failureJSON, object ["name" .= ("Timeout" :: Text), "message" .= ("exhausted" :: Text)]]
               , bulkContract "WorkflowStatus" [status, WorkflowStatus WorkflowComplete (Just (7 :: Int)) Nothing] [statusJSON, object ["status" .= ("complete" :: Text), "output" .= (7 :: Int)]]
               , bulkContract "WorkflowReceivedEvent" [event, event{workflowReceivedPayload = 8}] [eventJSON, object ["payload" .= (8 :: Int), "type" .= ("ready" :: Text), "timestamp" .= ("2026-09-12T00:00:00Z" :: Text)]]
               ]
        ]
  where
    sqlValues = [SQLNull, SQLText "row", SQLNumber 1.25, SQLBlob "blob"]
    statement = SQLStatement "SELECT ?" [SQLNumber 1]
    statements = [statement, SQLStatement "SELECT ?" [SQLNumber 2]]
    sqlResult = SQLResult ["name"] [[SQLText "row"]] 3 1
    sqlResultJSON = object ["columns" .= ["name" :: Text], "rows" .= [[SQLText "row"]], "rowsRead" .= (3 :: Int), "rowsWritten" .= (1 :: Int)]
    context = WorkflowStepContext "send" 1 1
    contextJSON = object ["step" .= object ["name" .= ("send" :: Text), "count" .= (1 :: Int)], "attempt" .= (1 :: Int)]
    failure = WorkflowFailure "Timeout" "waiting"
    failureJSON = object ["name" .= ("Timeout" :: Text), "message" .= ("waiting" :: Text)]
    status = WorkflowStatus WorkflowRunning (Nothing :: Maybe Int) Nothing
    statusJSON = object ["status" .= ("running" :: Text)]
    event = WorkflowReceivedEvent (7 :: Int) "ready" "2026-09-12T00:00:00Z"
    eventJSON = object ["payload" .= (7 :: Int), "type" .= ("ready" :: Text), "timestamp" .= ("2026-09-12T00:00:00Z" :: Text)]

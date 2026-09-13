module Support.Runtime.StorageBoundaries (queueOutcome, d1DecoderBoundaries, storageNativeProbe) where

import Cloudflare.Workers.Binding.Queue
import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query
import ExampleSupport.Interop (jsValToText, textToJSVal)
import Control.Exception (try, SomeException, displayException)
import Control.Monad (unless, void)
import Cloudflare.Workers.Binding.R2
import Data.Text qualified as Text
import Data.ByteString qualified as Bytes
import Cloudflare.Workers.Binding.DurableObject
import GHC.Wasm.Prim (JSVal)

-- The caller supplies a native producer so synchronous throws, rejected promises,
-- malformed metrics and recovery exercise the actual FFI rather than a mock in Haskell.
queueOutcome :: JSVal -> JSVal -> IO JSVal
queueOutcome producerValue commandValue = do
    command <- jsValToText commandValue
    let producer = QueueProducer producerValue
    result <- try @SomeException $ case command of
        "batch" -> void $ queueSendBatchWithOptions producer [(QueueTextBody "body", queueSendDefaultOptions)] queueBatchDefaultOptions
        "legacy-send" -> queueSend producer "body" queueSendDefaultOptions
        "legacy-batch" -> queueSendBatch producer [("body", queueSendDefaultOptions)]
        "clone-v8" -> do
            clone <- textToJSVal "clone"
            void $ queueSendValue producer (QueueV8StructuredClone (DurableObjectValue clone)) queueSendDefaultOptions
        "json" -> void $ queueSendValue producer (QueueJSONBody "{\"value\":1}") queueSendDefaultOptions
        "invalid-json" -> void $ queueSendValue producer (QueueJSONBody "{") queueSendDefaultOptions
        "invalid-json-batch" -> void $ queueSendBatchWithOptions producer [(QueueJSONBody "{", queueSendDefaultOptions)] queueBatchDefaultOptions
        "public-send" -> void $ queueSendValue producer (QueueTextBody "body") queueSendDefaultOptions
        "public-batch" -> void $ queueSendBatchWithOptions producer [(QueueTextBody "body", queueSendDefaultOptions)] queueBatchDefaultOptions
        _ -> void $ queueSendValue producer (QueueTextBody "body") queueSendDefaultOptions
    textToJSVal (either (Text.pack . show) (const "ok") result)

d1DecoderBoundaries :: IO JSVal
d1DecoderBoundaries = do
    let integer = d1Column "value" d1Integer
        number = d1Column "value" d1Double
        check condition = unless condition (fail "D1 decoder boundary contract failed")
    missing <- try @D1DecodeError (decodeD1RowOrThrow integer [])
    check (missing == Left (D1MissingColumn "value"))
    nullResult <- try @D1DecodeError (decodeD1RowOrThrow integer [("value", D1Null)])
    check (nullResult == Left (D1UnexpectedNull "value"))
    mismatch <- try @D1DecodeError (decodeD1RowOrThrow integer [("value", D1Text "not an integer")])
    check (mismatch == Left (D1ColumnTypeMismatch "value" D1IntegerType D1TextType))
    mapM_ (\value -> check (decodeD1Row integer [("value", D1Integer value)] == Right value)) [-9007199254740991, 9007199254740991]
    mapM_ (\value -> check (decodeD1Row integer [("value", D1Integer value)] == Left (D1InvalidColumnValue "value" "integer exceeds exact JavaScript numeric range"))) [-9007199254740992,9007199254740992]
    mapM_ (\value -> check (decodeD1Row number [("value", D1Real value)] == Left (D1InvalidColumnValue "value" "non-finite numeric value"))) [0/0,1/0,-1/0]
    check (decodeD1Rows integer [[("value", D1Integer 1)], [("value", D1Null)]] == Left (D1RowDecodeFailed 2 (D1UnexpectedNull "value")))
    -- Int is 32-bit in WASM: these branches cannot be reached with safe D1
    -- integers on a 64-bit host and must run at this boundary.
    mapM_ (\value -> check (decodeD1Row (d1Column "value" d1BoundedInt) [("value", D1Integer value)] == Left (D1InvalidColumnValue "value" "integer is outside the Int range"))) [-2147483649,2147483648]
    recovered <- decodeD1RowOrThrow integer [("value", D1Integer 42)]
    check (recovered == 42)
    textToJSVal "ok"


-- Native-shaped fixtures make failure recovery observable at the Haskell boundary.
storageNativeProbe :: JSVal -> JSVal -> IO JSVal
storageNativeProbe handle commandValue = do
    command <- jsValToText commandValue
    result <- try @SomeException $ case command of
        "do-list" -> Text.pack . show <$> doStorageList (DurableObjectStorage handle) Nothing False Nothing
        "do-put" -> doStoragePut (DurableObjectStorage handle) "key" "abc" >> pure "ok"
        "do-transaction" -> Text.pack . show <$> doStorageTransaction (DurableObjectStorage handle) [DurableObjectStorageOperationPut "key" "abc"]
        "r2-large-batch" -> r2DeleteMany (R2Bucket handle) (R2KeyBatch "key" (replicate 1000 "extra")) >> pure "unexpected"
        "r2-put-other-class" -> Text.pack . show <$> r2Put (R2Bucket handle) "key" (R2PutBytes "abc") r2PutDefaultOptions{r2ExtendedPutStorageClass = Just (R2OtherStorageClass "FutureClass")}
        "r2-list" -> Text.pack . show <$> r2List (R2Bucket handle) r2ListDefaultOptions
        "r2-put" -> Text.pack . show <$> r2Put (R2Bucket handle) "key" (R2PutBytes "abc") r2PutDefaultOptions
        "r2-create" -> r2CreateMultipartUpload (R2Bucket handle) "key" r2MultipartDefaultOptions >> pure "ok"
        "r2-upload" -> do
            upload <- r2ResumeMultipartUpload (R2Bucket handle) "key" "upload"
            Text.pack . show <$> r2UploadPart upload 1 (R2PutBytes "abc") Nothing
        "queue-validation" -> queueValidationProbe handle
        "d1-combinators" -> d1CombinatorProbe handle
        "r2-range-invalid" -> do
            outcomes <- mapM (\range -> try @R2Error (r2Get (R2Bucket handle) "key" r2GetDefaultOptions{r2GetOptionsRange = Just range}) >>= pure . either (Text.pack . show) (const "unexpected success"))
                [R2RangeOffsetLength (-1) 1, R2RangeOffsetLength 0 9007199254740992, R2RangeOffset (-1), R2RangeLength (-1), R2RangeSuffix (-1)]
            pure (Text.intercalate ";" outcomes)
        "r2-complete-retry" -> do
            upload <- r2ResumeMultipartUpload (R2Bucket handle) "key" "upload"
            first <- try @R2Error (r2CompleteMultipartUpload upload [R2UploadedPart 1 "etag"])
            second <- try @R2Error (r2CompleteMultipartUpload upload [R2UploadedPart 1 "etag"])
            third <- try @R2Error (r2UploadPart upload 2 (R2PutBytes "body") Nothing)
            pure (Text.pack (show (either (Left . show) (Right . r2ObjectMetaVersion) first, either (Left . show) (Right . r2ObjectMetaVersion) second, third)))
        "r2-delete" -> r2Delete (R2Bucket handle) "key" >> pure "ok"
        "r2-delete-many" -> r2DeleteMany (R2Bucket handle) (R2KeyBatch "first" ["second"]) >> pure "ok"
        "alarm-set-negative" -> doStorageSetAlarm (DurableObjectStorage handle) (-1) >> pure "ok"
        "alarm-set-unsafe" -> doStorageSetAlarm (DurableObjectStorage handle) 9007199254740992 >> pure "ok"
        "alarm-set" -> doStorageSetAlarm (DurableObjectStorage handle) 123 >> pure "ok"
        "alarm-delete" -> doStorageDeleteAlarm (DurableObjectStorage handle) >> pure "ok"
        "r2-get-body" -> do
            outcome <- r2Get (R2Bucket handle) "key" r2GetDefaultOptions
            case outcome of
                R2GetNotFound -> pure "missing"
                R2GetPreconditionFailed meta -> pure ("precondition:" <> r2ObjectMetaVersion meta <> ":" <> Text.pack (show (r2ObjectMetaRange meta)))
                R2GetSuccess object -> Text.pack . show <$> r2ObjectBodyReader object 10
        "r2-head" -> Text.pack . show <$> r2Head (R2Bucket handle) "key"
        "r2-abort-retry" -> do
            upload <- r2ResumeMultipartUpload (R2Bucket handle) "key" "upload"
            first <- try @R2Error (r2AbortMultipartUpload upload)
            second <- try @R2Error (r2AbortMultipartUpload upload)
            third <- try @R2Error (r2AbortMultipartUpload upload)
            pure (Text.pack (show (first, second, third)))
        "d1-query" -> Text.pack . show <$> d1Query (D1 handle) statement (d1Column "value" d1Integer)
        "d1-first" -> Text.pack . show <$> d1QueryFirst (D1 handle) statement (d1Column "value" d1Integer)
        "d1-execute" -> Text.pack . show <$> d1Execute (D1 handle) statement
        "d1-batch" -> Text.pack . show <$> d1ExecuteBatch (D1 handle) [statement, statement]
        _ | "r2-body-" `Text.isPrefixOf` command -> do
            outcome <- r2Get (R2Bucket handle) "key" r2GetDefaultOptions
            case outcome of
                R2GetSuccess object -> case command of
                    "r2-body-array" -> Text.pack . show <$> r2ObjectArrayBuffer object
                    "r2-body-bytes" -> Text.pack . show <$> r2ObjectBytes object
                    "r2-body-text" -> r2ObjectText object
                    "r2-body-json" -> r2ObjectJSON object
                    "r2-body-blob" -> r2ObjectBlob object >> pure "blob"
                    _ -> fail "unknown body method"
                _ -> fail "expected R2 object body"
        _ -> fail "unknown storage probe"
    textToJSVal (either (Text.pack . displayException) id result)
  where
    statement = D1Statement "SELECT ? AS value" [D1Integer 42]


queueValidationProbe :: JSVal -> IO Text.Text
queueValidationProbe handle = do
    let check condition = unless condition (fail "Queue validation contract failed")
        bytes count = QueueBytesBody (Bytes.replicate count 0)
        options seconds = queueSendDefaultOptions{queueSendOptionsDelaySeconds = Just seconds}
        entry = (bytes 1, queueSendDefaultOptions)
        batch = queueBatchDefaultOptions
        bodies = [QueueTextBody "あ", bytes 2, QueueJSONBody "{}", QueueV8Body "ab", QueueV8StructuredClone (DurableObjectValue handle)]
    check (map queueBodyContentType bodies == [QueueContentTypeText,QueueContentTypeBytes,QueueContentTypeJSON,QueueContentTypeV8,QueueContentTypeV8])
    check (map queueBodyByteLength bodies == [Just 3,Just 2,Nothing,Nothing,Nothing])
    check (validateQueueMessage (bytes 120000) queueSendDefaultOptions == Left (QueueMessageTooLarge 120000))
    check (validateQueueMessage (bytes 1) (options (-1)) == Left (QueueDelayOutOfRange (-1)))
    check (validateQueueBatch [] batch == Left QueueBatchEmpty)
    check (validateQueueBatch (replicate 101 entry) batch == Left (QueueBatchTooManyMessages 101))
    check (validateQueueBatch [entry,(bytes 120000,queueSendDefaultOptions)] batch == Left (QueueBatchMessageTooLarge 1 120000))
    check (validateQueueBatch [(bytes 100000,queueSendDefaultOptions),(bytes 100000,queueSendDefaultOptions),(bytes 56001,queueSendDefaultOptions)] batch == Left (QueueBatchTotalTooLarge 256001))
    check (validateQueueBatch [entry,(bytes 1,options 86401)] batch == Left (QueueBatchMessageDelayOutOfRange 1 86401))
    check (validateQueueBatch [entry] (QueueBatchOptions (Just 0)) == Left (QueueBatchDelayOutOfRange 0))
    check (validateQueueBatch [entry] (QueueBatchOptions (Just 86401)) == Left (QueueBatchDelayOutOfRange 86401))
    check (validateQueueBatch [(QueueJSONBody "{}", options 0)] (QueueBatchOptions (Just 1)) == Right ())
    check (validateQueueMessage (bytes 119999) (options 86400) == Right ())
    check (map queueMessageSerializedTotalSizeIsValid [-1,0,119999,120000] == [False,True,True,False])
    check (map queueBatchSerializedTotalSizeIsValid [-1,0,256000,256001] == [False,True,True,False])
    check (queueRejectionKind (classifyQueueRejection "batch total bytes exceeded") == QueueBatchBytesTooLargeRejction)
    pure "ok"

d1CombinatorProbe :: JSVal -> IO Text.Text
d1CombinatorProbe handle = do
    let check condition = unless condition (fail "D1 combinator contract failed")
        decode decoder value = decodeD1Row (d1Column "v" decoder) [("v",value)]
    check (decode d1Text D1Null == Left (D1UnexpectedNull "v"))
    check (decode d1Text (D1Integer 1) == Left (D1ColumnTypeMismatch "v" D1TextType D1IntegerType))
    check (decode d1Text (D1Real 1) == Left (D1ColumnTypeMismatch "v" D1TextType D1RealType))
    check (decode d1Text (D1Blob "a") == Left (D1ColumnTypeMismatch "v" D1TextType D1BlobType))
    check (decode d1Blob (D1Text "a") == Left (D1ColumnTypeMismatch "v" D1BlobType D1TextType))
    check (decode d1Blob (D1Blob "a") == Right "a")
    check (decode d1Double (D1Text "a") == Left (D1ColumnTypeMismatch "v" D1RealType D1TextType))
    check (decode d1Double (D1Integer 1) == Right 1)
    check (decode d1Double (D1Integer 9007199254740992) == Left (D1InvalidColumnValue "v" "integer exceeds exact JavaScript numeric range"))
    check (decode d1Bool (D1Integer 0) == Right False)
    check (decode d1Bool (D1Integer 1) == Right True)
    check (decode d1Bool (D1Integer 2) == Left (D1InvalidColumnValue "v" "boolean must be stored as integer 0 or 1"))
    check (decode (d1Nullable d1Text) D1Null == Right Nothing)
    check (decode (d1Nullable d1Text) (D1Text "value") == Right (Just "value"))
    check (decodeD1Row (pure (42 :: Integer)) [] == Right 42)
    let dependent = d1Column "v" d1Integer >>= \value -> pure (value + 1)
    check (decodeD1Row dependent [("v",D1Integer 1)] == Right 2)
    check (decodeD1Row dependent [] == Left (D1MissingColumn "v"))
    check (validateD1Statement (D1Statement "?" [D1Integer (-9007199254740992)]) == Left (D1InvalidParameter 1 "integer exceeds exact JavaScript numeric range"))
    check (decodeD1Row ((,) <$> d1Column "a" d1Integer <*> d1Column "b" d1Text) [("a",D1Integer 1),("b",D1Text "x")] == Right (1,"x"))
    check (validateD1Statement (D1Statement "?" [D1Integer 9007199254740992]) == Left (D1InvalidParameter 1 "integer exceeds exact JavaScript numeric range"))
    check (validateD1Statement (D1Statement "?" [D1Real (0/0)]) == Left (D1InvalidParameter 1 "non-finite numeric value"))
    check (validateD1Statement (D1Statement "?" [D1Real (1/0)]) == Left (D1InvalidParameter 1 "non-finite numeric value"))
    check (validateD1Statement (D1Statement "?" [D1Null,D1Text "x",D1Blob "x",D1Real 1]) == Right ())
    let reread = d1Column "a" d1Integer >>= \a -> (+ a) <$> d1Column "b" d1Integer
    check (decodeD1Row reread [("a",D1Integer 2),("b",D1Integer 3)] == Right 5)
    check (decodeD1Row reread [("a",D1Integer 2)] == Left (D1MissingColumn "b"))
    noWork <- d1ExecuteBatch (D1 handle) []
    check (null noWork)
    pure "ok"

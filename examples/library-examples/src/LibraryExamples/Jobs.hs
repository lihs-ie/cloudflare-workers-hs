module LibraryExamples.Jobs
  ( Job(..), JobsError(..), submitJobs, processJob, readJobState
  , initializeJobs, commitJob, jobState, saveSettings, settingsHistory, updateJobSettings, readSettingsHistory
  ) where

import Cloudflare.Workers.Binding.D1 (D1)
import Cloudflare.Workers.Binding.D1.Query
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Binding.DurableObject.SQL
import Cloudflare.Workers.Binding.Queue
import Cloudflare.Workers.Binding.ServiceBinding
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal, jsValToText)
import Control.Exception (Exception, throwIO)
import Control.Monad (unless, void)
import Data.Aeson
import Data.Aeson.Types (parseEither)
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)

-- Stable application identifiers, not Queue delivery identifiers, define deduplication.
data Job = Job { identifier :: Text, payload :: Text } deriving stock (Show, Eq)
instance FromJSON Job where
  parseJSON = withObject "Job" $ \o -> Job <$> o .: "identifier" <*> o .: "payload"
instance ToJSON Job where
  toJSON job = object ["identifier" .= identifier job, "payload" .= payload job]
data JobsError = JobInput | JobMissing | JobConflict deriving stock (Show, Eq)
instance Exception JobsError

data ProcessingSettings = ProcessingSettings Bool Int Double (Maybe Text) Bytes.ByteString
settingsDecoder :: D1RowDecoder ProcessingSettings
settingsDecoder = ProcessingSettings
  <$> d1Column "enabled" d1Bool
  <*> d1Column "batch_limit" (d1Refine (\n -> if n > 0 && n <= 100 then Right n else Left "batch limit must be 1..100") d1BoundedInt)
  <*> d1Column "score" (d1Refine (\n -> if n >= 0 && n <= 1 then Right n else Left "score must be 0..1") d1Double)
  <*> d1Column "description" (d1Nullable d1Text)
  <*> d1Column "attachment" d1Blob

submitJobs :: D1 -> ServiceBinding -> QueueProducer -> Value -> IO Value
submitJobs database validator producer request = do
  jobs <- either (const (throwIO JobInput)) pure (parseEither (withObject "Batch" (.: "jobs")) request)
  settings <- d1QueryFirst database (D1Statement "SELECT enabled,batch_limit,score,description,attachment FROM processing_settings WHERE identifier='default'" []) settingsDecoder
  ProcessingSettings enabled limit score description attachment <- maybe (throwIO JobMissing) pure settings
  unless enabled (throwIO JobConflict)
  unless (not (null jobs) && length jobs <= limit) (throwIO JobInput)
  argument <- DurableObjectValue <$> textToJSVal (jsonText (toJSON (jobs :: [Job])))
  result <- serviceCall validator "validate" [argument] >>= either throwIO pure
  accepted <- case result of DurableObjectValue raw -> jsValToText raw
  -- The remote validator returns structured errors as data, avoiding dependence
  -- on platform exception message formatting across an RPC boundary.
  unless (accepted == "accepted") (throwIO JobInput)
  void $ queueSendBatchWithOptions producer
    [(QueueJSONBody (jsonText (toJSON job)), queueSendDefaultOptions) | job <- jobs] queueBatchDefaultOptions
  pure $ object ["accepted" .= length jobs, "settings" .= object
    ["score" .= score, "description" .= description, "attachmentBytes" .= Bytes.length attachment]]

processJob :: DurableObjectNamespace -> Value -> IO ()
processJob namespace value = do
  job <- either (const (throwIO JobInput)) pure (parseEither parseJSON value)
  stub <- doGetByName namespace "jobs"
  argument <- DurableObjectValue <$> textToJSVal (jsonText (toJSON (job :: Job)))
  result <- doCall stub "commit" [argument] >>= either throwIO pure
  reply <- case result of DurableObjectValue raw -> jsValToText raw
  unless (reply == "committed" || reply == "duplicate") (throwIO JobConflict)

readJobState :: DurableObjectNamespace -> Text -> IO Value
readJobState namespace jobIdentifier = do
  stub <- doGetByName namespace "jobs"
  argument <- DurableObjectValue <$> textToJSVal jobIdentifier
  result <- doCall stub "status" [argument] >>= either throwIO pure
  raw <- case result of DurableObjectValue value -> jsValToText value
  value <- either (const (throwIO JobInput)) pure (eitherDecodeStrict' (encodeUtf8 raw))
  if value == Null then throwIO JobMissing else pure value

initializeJobs :: DurableObjectStorage -> IO ()
initializeJobs storage = void $ sqlBatch storage sqlDefaultLimits
  [ SQLStatement "CREATE TABLE IF NOT EXISTS job_state(identifier TEXT PRIMARY KEY,payload TEXT NOT NULL,updates INTEGER NOT NULL CHECK(updates=1))" []
  , SQLStatement "CREATE TABLE IF NOT EXISTS processed_jobs(identifier TEXT PRIMARY KEY,payload TEXT NOT NULL)" []
  ]

-- Both writes and the deduplication decision execute in one transactionSync.
-- A conflicting reuse of an identifier is reported without changing saved state.
commitJob :: DurableObjectStorage -> Text -> IO Text
commitJob storage raw = do
  job <- either (const (throwIO JobInput)) pure (eitherDecodeStrict' (encodeUtf8 raw))
  results <- sqlBatch storage sqlDefaultLimits
    [ SQLStatement "INSERT INTO job_state(identifier,payload,updates) SELECT ?,?,1 WHERE NOT EXISTS(SELECT 1 FROM processed_jobs WHERE identifier=?)" [SQLText (identifier job), SQLText (payload job), SQLText (identifier job)]
    , SQLStatement "INSERT OR IGNORE INTO processed_jobs(identifier,payload) VALUES(?,?)" [SQLText (identifier job), SQLText (payload job)]
    , SQLStatement "SELECT payload FROM processed_jobs WHERE identifier=?" [SQLText (identifier job)]
    ]
  case results of
    [inserted, _, verified] | rows verified == [[SQLText (payload job)]] ->
      pure (if rowsWritten inserted == 0 then "duplicate" else "committed")
    _ -> pure "conflict"

jobState :: DurableObjectStorage -> Text -> IO Text
jobState storage jobIdentifier = do
  result <- sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT identifier,payload,updates FROM job_state WHERE identifier=?" [SQLText jobIdentifier])
  case rows result of
    [] -> pure "null"
    [[SQLText name, SQLText body, SQLNumber updates]] -> pure $ jsonText $ object ["identifier" .= name, "payload" .= body, "updates" .= updates]
    _ -> throwIO JobConflict

-- The TS entrypoint serializes this entire read/transaction/prune operation.
-- Pruning is resumable: a failed deletion is retried by the next settings update.
saveSettings :: DurableObjectStorage -> Text -> IO Text
saveSettings storage raw = do
  value <- either (const (throwIO JobInput)) pure (eitherDecodeStrict' (encodeUtf8 raw) :: Either String Value)
  current <- doStorageGet storage "settings:current"
  revision <- case current of
    Nothing -> pure (1 :: Int)
    Just bytes -> case eitherDecodeStrict' bytes >>= parseEither (withObject "Settings" (.: "revision")) of
      Left _ -> throwIO JobConflict
      Right old -> pure (old + 1)
  let record = object ["revision" .= revision, "settings" .= value]
      bytes = Lazy.toStrict (encode record)
      key = "settings:history:" <> Text.justifyRight 12 '0' (Text.pack (show revision))
  doStorageTransaction storage [DurableObjectStorageOperationPut "settings:current" bytes, DurableObjectStorageOperationPut key bytes] >>= either throwIO pure
  history <- doStorageList storage (Just "settings:history:") True Nothing
  mapM_ (void . doStorageDelete storage . fst) (drop 3 history)
  pure (jsonText record)

settingsHistory :: DurableObjectStorage -> IO Text
settingsHistory storage = do
  records <- doStorageList storage (Just "settings:history:") True (Just 3)
  values <- traverse (either (const (throwIO JobConflict)) pure . eitherDecodeStrict' . snd) records
  pure (jsonText (toJSON (values :: [Value])))

jsonText :: Value -> Text
jsonText = decodeUtf8 . Lazy.toStrict . encode

updateJobSettings :: DurableObjectNamespace -> Value -> IO Value
updateJobSettings namespace value = callStateJSON namespace "saveSettings" [jsonText value]

readSettingsHistory :: DurableObjectNamespace -> IO Value
readSettingsHistory namespace = callStateJSON namespace "history" []

callStateJSON :: DurableObjectNamespace -> Text -> [Text] -> IO Value
callStateJSON namespace method arguments = do
  stub <- doGetByName namespace "jobs"
  encoded <- traverse (fmap DurableObjectValue . textToJSVal) arguments
  DurableObjectValue raw <- doCall stub method encoded >>= either throwIO pure
  text <- jsValToText raw
  either (const (throwIO JobConflict)) pure (eitherDecodeStrict' (encodeUtf8 text))

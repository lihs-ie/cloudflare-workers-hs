module Quickstart.ExportGeneration.Application (generateExport, failExport) where
import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Streaming
import Control.Monad (void, when)
import Data.Text (Text)
import Data.Text qualified as T
import Data.Text.Encoding qualified as TE
import Data.ByteString qualified as BS
import Data.Time (UTCTime)
import Data.Time.Clock.POSIX (posixSecondsToUTCTime)
import Quickstart.Background.Coordinator (withLease)
import Quickstart.Background.Environment
import Quickstart.Database
import Quickstart.ExportGeneration.Producer (headerBytes, produceCSV)
import URLShortener.Domain (exportExpiresAt)

-- A materialized snapshot is created atomically exactly once. Pages read only
-- immutable snapshot rows, so concurrent click ingestion cannot mix snapshots.
generateExport :: BackgroundEnv -> Text -> IO ()
generateExport env identifier = withLease (coordinator env) identifier $ \renew -> generateExportLeased renew env identifier

generateExportLeased :: IO () -> BackgroundEnv -> Text -> IO ()
generateExportLeased renew env identifier = do
  now <- currentTime env
  void $ batch db
    [ ("INSERT OR IGNORE INTO export_rows(export,url,day,count) SELECT e.identifier,d.url,d.day,d.count FROM exports e JOIN daily_clicks d ON d.day>=e.start_day AND d.day<=e.end_day WHERE e.identifier=? AND e.snapshot_at IS NULL",[D1Text identifier])
    , ("UPDATE exports SET snapshot_at=?,status='generating' WHERE identifier=? AND snapshot_at IS NULL",[timeValue now,D1Text identifier])
    ]
  existing <- first db "SELECT status,snapshot_at,object_key FROM exports WHERE identifier=?" [D1Text identifier]
  case existing of
    Nothing -> pure ()
    Just row -> do
      state <- textColumn "status" row
      when (state `elem` ["pending", "generating"]) $ do
        key <- textColumn "object_key" row
        snapshot <- textColumn "snapshot_at" row
        byteCount <- measure snapshot "" "" (toInteger (BS.length headerBytes))
        source <- readableStreamFromProducer $ \emit -> produceCSV emit (page snapshot)
        stream <- readableStreamWithLength byteCount source
        renew
        result <- r2Put (bucket env) key (R2PutStream stream) r2PutDefaultOptions
          { r2ExtendedPutHttpMetadata = r2HttpMetadataDefault
              {r2HttpMetadataContentType=Just "text/csv;charset=utf-8",r2HttpMetadataCacheControl=Just "private, no-store"}
          , r2ExtendedPutCustomMetadata = [("snapshotAt",snapshot)]
          , r2ExtendedPutOnlyIf = Just (R2OnlyIfConditional (R2Condition Nothing (Just "*") Nothing Nothing))
          }
        -- A previous attempt may have uploaded successfully and crashed before
        -- updating D1. The immutable existing object is the same snapshot.
        completed <- case result of
          R2PutStored meta -> pure (uploadedAt meta)
          R2PutPreconditionFailed -> do
            readableStreamCancel stream
            existingMeta <- r2Head (bucket env) key
            case existingMeta of
              Nothing -> fail "Export conditional put failed but object is absent"
              Just meta -> pure (uploadedAt meta)
        renew
        void $ execute db "UPDATE exports SET status='complete',completed_at=?,expires_at=? WHERE identifier=? AND status<>'complete'"
          [timeValue completed,timeValue (exportExpiresAt completed),D1Text identifier]
 where
  db = database env
  measure snapshot afterURL afterDay total = do
    output <- page snapshot afterURL afterDay
    case output of
      [] -> pure total
      _ -> let (url,day,_) = last output
               size = sum [toInteger (BS.length (TE.encodeUtf8 line)) | (_,_,line) <- output]
           in measure snapshot url day (total + size)
  page snapshot afterURL afterDay = do
    renew
    rows <- query db "SELECT url,day,count FROM export_rows WHERE export=? AND (url>? OR (url=? AND day>?)) ORDER BY url,day LIMIT 100"
      [D1Text identifier,D1Text afterURL,D1Text afterURL,D1Text afterDay]
    traverse (\row -> do
      url <- textColumn "url" row
      day <- textColumn "day" row
      count <- integerColumn "count" row
      pure (url,day,T.intercalate "," (map csvCell [url,day,T.pack (show count),snapshot]) <> "\r\n")) rows

csvCell :: Text -> Text
csvCell value = "\"" <> T.replace "\"" "\"\"" value <> "\""

uploadedAt :: R2ObjectMeta -> UTCTime
uploadedAt meta = posixSecondsToUTCTime (fromInteger (r2ObjectMetaUploaded meta) / 1000)

-- Mark exhausted generation retries durably before acknowledging the message.
-- Completed output is immutable even if a concurrent stale attempt failed.
failExport :: BackgroundEnv -> Text -> IO ()
failExport env identifier = void $ execute (database env)
  "UPDATE exports SET status='failed',last_error='Generation retries exhausted' WHERE identifier=? AND status<>'complete'"
  [D1Text identifier]

-- | Internal CSV production, independent of the upload transport. A cancelled
-- emitter must stop page reads as well as writes so abandoned exports do not
-- keep querying the snapshot or renewing their lease.
module Quickstart.ExportGeneration.Producer (headerBytes, produceCSV) where

import Cloudflare.Workers.Streaming (StreamEmitOutcome(..), StreamProducerOutcome(..))
import Data.ByteString (ByteString)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text

-- | Shared by byte-length measurement and the actual emitted stream.
headerBytes :: ByteString
headerBytes = Text.encodeUtf8 "url,day,count,snapshot_at\r\n"

-- | Read ordered, bounded snapshot pages only after the preceding write was
-- accepted. The reader receives the last accepted row's URL and day cursor;
-- each result carries that cursor and its already escaped CSV row.
produceCSV ::
  (ByteString -> IO StreamEmitOutcome) ->
  (Text -> Text -> IO [(Text, Text, Text)]) ->
  IO StreamProducerOutcome
produceCSV emit readPage = do
  accepted <- emit headerBytes
  case accepted of
    StreamEmitCancelled -> pure StreamProducerCompleted
    StreamEmitAccepted -> pages "" ""
 where
  pages afterURL afterDay = do
    output <- readPage afterURL afterDay
    case output of
      [] -> pure StreamProducerCompleted
      _ -> do
        delivered <- emit (Text.encodeUtf8 (Text.concat [line | (_, _, line) <- output]))
        case delivered of
          StreamEmitCancelled -> pure StreamProducerCompleted
          StreamEmitAccepted -> let (url, day, _) = last output in pages url day

module Support.Runtime.ExportProducer (exportProducerProbe) where

import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Streaming (StreamEmitOutcome(..), StreamProducerOutcome(..))
import Control.Exception (IOException, displayException, throwIO, try)
import Data.Aeson (encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.IORef
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)
import Quickstart.ExportGeneration.Producer (produceCSV)

-- Real IO emitter outcomes exercise the production pagination protocol without
-- depending on when the native fixed-length pump schedules its first read.
exportProducerProbe :: JSVal -> IO JSVal
exportProducerProbe modeValue = do
  mode <- jsValToText modeValue
  writes <- newIORef ([] :: [Text])
  reads <- newIORef ([] :: [(Text, Text)])
  events <- newIORef ([] :: [Text])
  let emit bytes = do
        modifyIORef' writes (<> [decodeUtf8 bytes])
        modifyIORef' events (<> ["emit"])
        emitted <- length <$> readIORef writes
        pure $ if mode == "header-cancel" || (mode == "page-cancel" && emitted == 2)
          then StreamEmitCancelled else StreamEmitAccepted
      page url day = do
        modifyIORef' reads (<> [(url, day)])
        modifyIORef' events (<> ["read"])
        if mode == "reader-failure"
          then throwIO (userError "snapshot read failed")
          else pure $ if url == ""
            then [("a", "2026-09-01", "row-a\r\n"), ("b", "2026-09-02", "row-b\r\n")]
            else []
  result <- try @IOException (produceCSV emit page)
  emitted <- readIORef writes
  requested <- readIORef reads
  ordered <- readIORef events
  textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ object
    [ "completed" .= either (const False) (== StreamProducerCompleted) result
    , "error" .= either displayException (const "") result
    , "writes" .= emitted
    , "reads" .= requested
    , "events" .= ordered
    ]

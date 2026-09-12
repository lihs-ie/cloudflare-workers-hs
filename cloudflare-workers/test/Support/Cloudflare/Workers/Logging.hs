module Support.Cloudflare.Workers.Logging (captureStderr) where
import Control.Exception (bracket)
import Data.Text (Text)
import Data.Text.IO qualified as TextIO
import GHC.IO.Handle (hDuplicate, hDuplicateTo)
import System.IO
import System.IO.Temp (withSystemTempFile)
-- Call from sequential tests: stderr is a process-wide resource.
captureStderr :: IO a -> IO (a, Text)
captureStderr action = withSystemTempFile "workers-test-stderr" $ \_ capture -> do
  result <- bracket (hDuplicate stderr) (\saved -> hDuplicateTo saved stderr >> hClose saved) $ \_ -> do
    hDuplicateTo capture stderr
    value <- action
    hFlush stderr
    pure value
  hSeek capture AbsoluteSeek 0
  output <- TextIO.hGetContents capture
  pure (result, output)

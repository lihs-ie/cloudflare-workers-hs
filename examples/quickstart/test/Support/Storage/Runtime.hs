module Support.Storage.Runtime (runOperations, runOperationsWith) where

import Data.Aeson (Value, eitherDecodeStrict', encode)
import Data.ByteString.Lazy qualified as Lazy
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import Paths_quickstart (getDataFileName)
import Support.Storage.Model (Operation (..))
import System.Exit (ExitCode (..))
import System.Process (readProcessWithExitCode)

runOperations :: [Operation] -> IO [Value]
runOperations commands = do
    bridge <- getDataFileName "test/Support/Runtime/storage-bridge.mjs"
    runOperationsWith bridge readProcessWithExitCode commands

-- Injectable process boundary keeps host contract checks independent of WASM.
runOperationsWith :: FilePath -> (FilePath -> [String] -> String -> IO (ExitCode, String, String)) -> [Operation] -> IO [Value]
runOperationsWith bridge runProcess commands = do
    if all valid commands then pure () else fail "Storage model bytes must be between 0 and 255"
    (code, output, errors) <- runProcess "node" [bridge] (Text.unpack (Text.decodeUtf8 (Lazy.toStrict (encode commands))))
    case code of
        ExitFailure n -> fail $ "Storage model bridge exited " <> show n <> ": " <> errors
        ExitSuccess -> either fail pure $ eitherDecodeStrict' (Text.encodeUtf8 (Text.pack output))

  where
    valid (Put _ bytes) = all (\byte -> byte >= 0 && byte <= 255) bytes
    valid (Transaction _ bytes) = all (\byte -> byte >= 0 && byte <= 255) bytes
    valid _ = True

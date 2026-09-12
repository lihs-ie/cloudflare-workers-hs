-- A packaging consumer of the public manifest, not a production validator.
module Support.BundleFixture (writeBundle, inspectBundle, emptyWasm) where

import Cloudflare.Workers.Bundle
import Control.Exception (IOException, try)
import Data.ByteString qualified as BS
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.IO qualified as Text
import System.FilePath ((</>))

emptyWasm :: BS.ByteString
emptyWasm = BS.pack [0, 97, 115, 109, 1, 0, 0, 0]

writeBundle :: FilePath -> IO BundleManifest
writeBundle directory = do
  Text.writeFile (directory </> "worker.mjs") (entryFor "reactor.wasm")
  BS.writeFile (directory </> "reactor.wasm") emptyWasm
  pure (BundleManifest "worker.mjs" "reactor.wasm")

entryFor :: Text -> Text
entryFor wasm = "import reactor from './" <> wasm <> "';\nexport default reactor;\n"

-- Read both actual artifacts through the manifest. Errors retain the manifest
-- so a packaging failure identifies the exact entry/WASM pairing.
inspectBundle :: FilePath -> BundleManifest -> IO (Either String BS.ByteString)
inspectBundle directory manifest = do
  result <- try @IOException $ do
    entry <- Text.readFile (directory </> Text.unpack (bundleManifestEntryPoint manifest))
    wasm <- BS.readFile (directory </> Text.unpack (budnleManifestWasmPath manifest))
    pure $ if entry /= entryFor (budnleManifestWasmPath manifest)
      then Left "entry does not reference manifest WASM"
      else if wasm /= emptyWasm
        then Left "unexpected WASM magic/version or payload"
        else Right wasm
  pure $ case result of
    Left exception -> Left (show manifest <> ": " <> show exception)
    Right (Left reason) -> Left (show manifest <> ": " <> reason)
    Right (Right wasm) -> Right wasm

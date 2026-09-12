module Cloudflare.Workers.BundleSpec (spec) where

import Cloudflare.Workers.Bundle
import Control.Exception (SomeException, displayException)
import Data.ByteString qualified as BS
import Data.List (isInfixOf)
import Data.Text.IO qualified as Text
import Support.BundleFixture
import System.Directory (removeFile)
import System.FilePath ((</>))
import System.IO.Temp (withSystemTempDirectory)
import Test.Syd

spec :: Spec
spec = do
  it "renders every manifest in a multi-worker packaging diagnostic" $ do
    let manifests = [BundleManifest "api.mjs" "api.wasm", BundleManifest "jobs.mjs" "jobs.wasm"]
        diagnostic = "Packaging candidates: " <> show manifests
    diagnostic `shouldBe` "Packaging candidates: [BundleManifest {bundleManifestEntryPoint = \"api.mjs\", budnleManifestWasmPath = \"api.wasm\"},BundleManifest {bundleManifestEntryPoint = \"jobs.mjs\", budnleManifestWasmPath = \"jobs.wasm\"}]"
  it "does not accept a successful artifact result as an expected failure" $
    expectFailureContaining ["missing"] (Right emptyWasm)
      `shouldThrow` (isInfixOf "invalid artifact pairing was accepted" . displayException @SomeException)
  it "does not accept a diagnostic missing a required fragment" $
    expectFailureContaining ["missing WASM"] (Left "unrelated problem")
      `shouldThrow` (isInfixOf "False" . displayException @SomeException)
  it "packages an entry and the referenced WASM through the public manifest" $
    withSystemTempDirectory "bundle-contract" $ \directory -> do
      manifest <- writeBundle directory
      manifest `shouldBe` BundleManifest "worker.mjs" "reactor.wasm"
      inspectBundle directory manifest >>= (`shouldBe` Right emptyWasm)
  it "rejects an existing entry paired with the wrong WASM and diagnoses the manifest" $
    withSystemTempDirectory "bundle-contract" $ \directory -> do
      manifest <- writeBundle directory
      Text.writeFile (directory </> "other.mjs") "import reactor from './other.wasm';\nexport default reactor;\n"
      let mismatched = manifest {bundleManifestEntryPoint = "other.mjs"}
      mismatched `shouldNotBe` manifest
      inspectBundle directory mismatched >>= expectFailureContaining [show mismatched, "does not reference"]
  it "distinguishes WASM paths for the same entry and rejects a stale reference" $
    withSystemTempDirectory "bundle-contract" $ \directory -> do
      manifest <- writeBundle directory
      BS.writeFile (directory </> "replacement.wasm") emptyWasm
      let replacement = manifest {budnleManifestWasmPath = "replacement.wasm"}
      replacement `shouldNotBe` manifest
      inspectBundle directory replacement >>= expectFailureContaining [show replacement, "does not reference"]
  it "rejects a missing WASM artifact and succeeds after it is restored" $
    withSystemTempDirectory "bundle-contract" $ \directory -> do
      manifest <- writeBundle directory
      removeFile (directory </> "reactor.wasm")
      inspectBundle directory manifest >>= expectFailureContaining [show manifest, "reactor.wasm", "does not exist"]
      BS.writeFile (directory </> "reactor.wasm") emptyWasm
      inspectBundle directory manifest >>= (`shouldBe` Right emptyWasm)
  it "rejects corrupt WASM bytes even when the entry matches" $
    withSystemTempDirectory "bundle-contract" $ \directory -> do
      manifest <- writeBundle directory
      BS.writeFile (directory </> "reactor.wasm") (BS.pack [0, 97, 115, 109, 2, 0, 0, 0])
      inspectBundle directory manifest >>= expectFailureContaining [show manifest, "magic/version"]

expectFailureContaining :: [String] -> Either String BS.ByteString -> IO ()
expectFailureContaining fragments result = case result of
  Left diagnostic -> mapM_ (\fragment -> (fragment `isInfixOf` diagnostic) `shouldBe` True) fragments
  Right _ -> expectationFailure "invalid artifact pairing was accepted"

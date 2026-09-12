module Support.DiscoveryFixtures (withLayer) where

import System.Directory (createDirectoryIfMissing)
import System.FilePath ((</>))
import System.IO.Temp (withSystemTempDirectory)

withLayer :: (FilePath -> FilePath -> IO a) -> IO a
withLayer action = withSystemTempDirectory "layer discovery " $ \root -> do
    let layer = root </> "test" </> "unit"
    createDirectoryIfMissing True (layer </> "HTTP")
    writeFile (layer </> "Spec.hs") ""
    writeFile (layer </> "HTTPSpec.hs") "module HTTPSpec where\nspec = pure ()\n"
    writeFile (layer </> "HTTP" </> "RequestCases.hs") "module HTTP.RequestCases where\n"
    createDirectoryIfMissing True (root </> "test" </> "Support")
    writeFile (root </> "test" </> "Support" </> "HiddenSpec.hs") ""
    action root layer

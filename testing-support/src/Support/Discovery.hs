module Support.Discovery (discoverLayer) where

import Data.Char (isUpper)
import System.Directory (makeAbsolute, withCurrentDirectory)
import System.Environment (getArgs, withArgs)
import System.FilePath (takeDirectory, takeFileName)
import Test.Syd.Discover (sydTestDiscover)

-- sydtest-discover 0.0.0.4 walks relative to the test root's parent.
-- GHC invokes its preprocessor from the package root, which differs for
-- test/unit and test/conformance. Keep upstream discovery, fixing only cwd.
discoverLayer :: IO ()
discoverLayer = do
    arguments <- getArgs
    case arguments of
        source : input : output : options -> do
            absoluteSource <- makeAbsolute source
            absoluteInput <- makeAbsolute input
            absoluteOutput <- makeAbsolute output
            let base = testBase (takeDirectory absoluteSource)
            withCurrentDirectory (takeDirectory base) $
                withArgs (absoluteSource : absoluteInput : absoluteOutput : options) sydTestDiscover
        _ -> ioError (userError "sydtest-discover-layer: expected GHC source, input and output paths")
  where
    testBase directory = case takeFileName directory of
        first : _ | isUpper first && takeDirectory directory /= directory -> testBase (takeDirectory directory)
        _ -> directory

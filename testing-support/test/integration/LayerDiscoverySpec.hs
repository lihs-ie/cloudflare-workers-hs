module LayerDiscoverySpec (spec) where

import Data.List (isInfixOf)
import Support.Discovery (discoverLayer)
import Support.DiscoveryFixtures (withLayer)
import System.Directory (getCurrentDirectory, withCurrentDirectory)
import System.Environment (withArgs)
import System.FilePath ((</>))
import System.IO.Error (ioeGetErrorString)
import Test.Syd

spec :: Spec
-- getArgs and cwd are process-wide; these fixtures deliberately exercise both.
spec = sequential $ describe "layered discovery" $ do
    it "collects only entries in a nested test layer and restores cwd" $
        withLayer $ \root _ -> withCurrentDirectory root $ do
            let output = root </> "generated.hs"
            withArgs ["test/unit/Spec.hs", "test/unit/Spec.hs", output] discoverLayer
            generated <- readFile output
            generated `shouldSatisfy` isInfixOf "import qualified HTTPSpec"
            generated `shouldSatisfy` (not . isInfixOf "RequestCases")
            generated `shouldSatisfy` (not . isInfixOf "HiddenSpec")
            current <- getCurrentDirectory
            current `shouldBe` root
    it "supports absolute preprocessor paths from another working directory" $
        withLayer $ \root layer -> do
            let output = root </> "absolute.hs"
            withArgs [layer </> "Spec.hs", layer </> "Spec.hs", output] discoverLayer
            generated <- readFile output
            generated `shouldSatisfy` isInfixOf "HTTPSpec.spec"
    it "finds the test layer above an uppercase module directory and restores cwd" $
        withLayer $ \root layer -> withCurrentDirectory root $ do
            let nestedSource = layer </> "HTTP" </> "Spec.hs"
                output = root </> "nested.hs"
            writeFile nestedSource ""
            writeFile (layer </> "HTTP" </> "RequestSpec.hs") "module HTTP.RequestSpec where\nspec = pure ()\n"
            withArgs [nestedSource, nestedSource, output] discoverLayer
            generated <- readFile output
            generated `shouldSatisfy` isInfixOf "HTTP.RequestSpec.spec"
            generated `shouldSatisfy` (not . isInfixOf "HTTPSpec.spec")
            generated `shouldSatisfy` (not . isInfixOf "HiddenSpec")
            current <- getCurrentDirectory
            current `shouldBe` root
    it "rejects missing GHC preprocessor arguments" $
        withArgs [] discoverLayer `shouldThrow` ((== "sydtest-discover-layer: expected GHC source, input and output paths") . ioeGetErrorString)

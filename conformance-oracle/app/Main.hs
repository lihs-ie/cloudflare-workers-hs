module Main (main) where
import Support.Conformance.Oracle (goldenDocument)
import Data.Aeson (encode)
import qualified Data.ByteString.Lazy as LBS
import System.Environment (getArgs)
main :: IO ()
main = do
  args <- getArgs
  case args of
    [destination] -> goldenDocument >>= LBS.writeFile destination . encode
    _ -> fail "Usage: regenerate-conformance-golden OUTPUT.json"

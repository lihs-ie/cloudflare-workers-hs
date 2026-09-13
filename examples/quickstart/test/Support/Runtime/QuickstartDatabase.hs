module Support.Runtime.QuickstartDatabase (preparedQueryProbe) where

import Cloudflare.Workers.Binding.D1 (D1(..), D1Value(..), d1All, d1ResultResults)
import ExampleSupport.Interop (textToJSVal)
import Data.Aeson (encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)
import Quickstart.Database qualified as Database

-- Use the application's public preparation wrapper with actual bound D1 SQL.
-- Read the result back so preparation is checked through its consumer contract.
preparedQueryProbe :: JSVal -> IO JSVal
preparedQueryProbe database = do
  statement <- Database.prepare (D1 database) "SELECT ? AS label, ? AS count" [D1Text "prepared-value", D1Integer 7]
  result <- d1All statement
  values <- case d1ResultResults result of
    [row] -> do
      label <- Database.textColumn "label" row
      count <- Database.integerColumn "count" row
      pure (object ["label" .= label, "count" .= count])
    _ -> fail "Expected one prepared query row"
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode values)))

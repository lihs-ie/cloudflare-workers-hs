module Support.Runtime.ExportRequestCodec (exportRequestCodecProbe) where

import ExampleSupport.Interop (jsValToText, textToJSVal)
import Data.Aeson (Value, eitherDecodeStrict', encode, object, toJSON, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding qualified as Text
import GHC.Wasm.Prim (JSVal)
import Quickstart.Export.Application (ExportRequest)

-- The public request payload is also useful to clients persisting/replaying
-- export submissions. Exercise its single/list wire representations, not its
-- generated diagnostic Show or Generic selector functions in isolation.
exportRequestCodecProbe :: JSVal -> IO JSVal
exportRequestCodecProbe input = do
  wire <- Text.encodeUtf8 <$> jsValToText input
  let decoded = eitherDecodeStrict' wire :: Either String [ExportRequest]
  let result = case decoded of
        Left _ -> object ["valid" .= False]
        Right values -> object
          [ "valid" .= True
          , "requests" .= values
          , "values" .= map toJSON values
          , "encoded" .= Text.decodeUtf8 (Lazy.toStrict (encode values))
          , "singleWires" .= map (Text.decodeUtf8 . Lazy.toStrict . encode) values
          ]
  textToJSVal (Text.decodeUtf8 (Lazy.toStrict (encode (result :: Value))))

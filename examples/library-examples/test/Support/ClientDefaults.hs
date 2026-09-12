-- | Run the exported default application policy against an owned HTTP fixture.
module Support.ClientDefaults (clientDefaultOptions, clientOptionDiagnostics) where

import Cloudflare.Workers.Internal.FFI.Text (textToJSVal, jsValToText)
import Data.Aeson (encode, toJSON)
import Data.ByteString.Lazy qualified as Lazy
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)
import LibraryExamples.Client (clientOptionsExample, defaultExampleClientOptions, mkExampleClientOptions)
import Servant.Client.Core (parseBaseUrl)

clientDefaultOptions :: JSVal -> IO JSVal
clientDefaultOptions origin = do
    target <- parseBaseUrl . Text.unpack =<< jsValToText origin
    result <- clientOptionsExample defaultExampleClientOptions target
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode result)))

-- Consumer-facing validation diagnostics retain specific invalid-policy reasons.
clientOptionDiagnostics :: IO JSVal
clientOptionDiagnostics = do
    let rejected = [mkExampleClientOptions 0 0 0, mkExampleClientOptions 1000 (-1) 0, mkExampleClientOptions 1000 0 (-1)]
        diagnostics = map (either id (const "unexpected valid policy")) rejected
    textToJSVal (decodeUtf8 (Lazy.toStrict (encode (toJSON diagnostics))))

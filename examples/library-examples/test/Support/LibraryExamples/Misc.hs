module Support.LibraryExamples.Misc (loggingUnknownRecovery, miscSocketFailure, miscStorageUnknown) where

import Cloudflare.Workers.Socket (SocketConnector(..))
import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Support.SocketFailures (runSocketFailure)
import Support.Storage (storageValidation)
import LibraryExamples.Logging (loggingExample)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Control.Exception (try, IOException, SomeException)
import Data.Aeson (encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)

loggingUnknownRecovery :: IO JSVal
loggingUnknownRecovery = do
    result <- try @IOException (loggingExample "unknown-profile")
    recovered <- loggingExample "warnings"
    let rejected = case result of
            Left _ -> True
            Right _ -> False
    textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ object
        ["rejected" .= rejected, "recovered" .= recovered]

-- Probe public fixture dispatch and failure callbacks without exposing exception text.
miscSocketFailure :: JSVal -> JSVal -> IO JSVal
miscSocketFailure connector rawScenario = do
    scenario <- jsValToText rawScenario
    outcome <- try @SomeException (runSocketFailure (SocketConnector connector) scenario "fixture.invalid:1234")
    textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ object
        ["rejected" .= either (const True) (const False) outcome]

miscStorageUnknown :: IO JSVal
miscStorageUnknown = do
    mode <- textToJSVal "unknown"
    result <- try @IOException (storageValidation mode mode)
    textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ object
        ["rejected" .= either (const True) (const False) result]

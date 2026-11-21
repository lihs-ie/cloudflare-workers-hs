module Support.Runtime.PlatformChecks (sqlChecks, upgradeChecks) where

import Cloudflare.Workers.Entrypoint.DurableObject
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.HTTP (Response(..), Status(..))
import Cloudflare.Workers.Headers (headersFromList)
import Control.Exception (SomeException, try)
import Data.Aeson (encode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)
import WorkersSupport.Interop (jsValToText, responseToJSVal, textToJSVal)
import Support.Runtime.DurableObject.SQLChecks qualified as SQLFixture

sqlChecks :: JSVal -> IO JSVal
sqlChecks storage = textToJSVal . decodeUtf8 . Lazy.toStrict . encode =<< SQLFixture.sqlChecks (DurableObjectStorage storage)

upgradeChecks :: IO JSVal
upgradeChecks = do
  (client, _) <- webSocketPair
  response <- webSocketUpgradeResponse client
  accepted <- responseToJSVal response{responseHeaders = headersFromList [("x-upgrade", "retained")]}
  header <- jsHeader accepted >>= jsValToText
  rejected <- try @SomeException (responseToJSVal response{responseStatus = Status 403})
  invalidIdentifier <- try @DurableObjectError (doIDToString . DurableObjectID =<< jsInvalidIdentifier)
  throwingIdentifier <- try @DurableObjectError (doIDToString . DurableObjectID =<< jsThrowingIdentifier)
  let identifierRejected value = case value of Left (DurableObjectIDSerializationFailed _) -> True; _ -> False
      failed = case rejected of Left _ -> True; Right _ -> False
  textToJSVal (decodeUtf8 (Lazy.toStrict (encode (object ["header" .= header, "statusMutationRejected" .= failed, "invalidIdentifierRejected" .= identifierRejected invalidIdentifier, "throwingIdentifierRejected" .= identifierRejected throwingIdentifier]))))
foreign import javascript unsafe "$1.headers.get('x-upgrade')" jsHeader :: JSVal -> IO JSVal

foreign import javascript unsafe "({ toString() { return 42; } })" jsInvalidIdentifier :: IO JSVal
foreign import javascript unsafe "({ toString() { throw new Error('identifier fixture failure'); } })" jsThrowingIdentifier :: IO JSVal

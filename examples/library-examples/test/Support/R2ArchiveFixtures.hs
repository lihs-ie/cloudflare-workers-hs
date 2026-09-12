-- | Strict native-call shape validation, separate from local capability tests.
module Support.R2ArchiveFixtures (uploadPartKeyContract) where

import Cloudflare.Workers.Internal.FFI.R2 (r2UploadPartViaFFI, R2PutValueViaFFI(..))
import Data.Aeson (Value, object, (.=))
import Data.ByteString qualified as Bytes
import GHC.Wasm.Prim (JSVal)

uploadPartKeyContract :: IO Value
uploadPartKeyContract = do
  target <- strictUpload
  absent <- r2UploadPartViaFFI target 1 (R2PutTextViaFFI "plain") Nothing
  present <- r2UploadPartViaFFI target 2 (R2PutTextViaFFI "encrypted") (Just (Bytes.pack [0..31]))
  pure (object ["absentKeyOmitted" .= (absent == Right (1, "absent-key"))
    , "presentKeyBytesPreserved" .= (present == Right (2, "present-key"))])

foreign import javascript unsafe "({ uploadPart: async (number, body, options) => { if (!options || typeof options !== 'object') { throw new Error('options required'); } const key = options.ssecKey; if (number === 1) { if (key !== undefined) { throw new Error('absent key must be undefined'); } return {partNumber:number,etag:'absent-key'}; } if (!(key instanceof Uint8Array) || key.byteLength !== 32 || !key.every((byte, index) => byte === index)) { throw new Error('options must preserve exact key bytes'); } return {partNumber:number,etag:'present-key'}; } })"
  strictUpload :: IO JSVal

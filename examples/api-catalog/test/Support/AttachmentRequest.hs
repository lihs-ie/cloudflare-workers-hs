-- | Exercise the public Request constructor without a native body adapter.
module Support.AttachmentRequest (attachmentMissingReader) where

import Cloudflare.Workers.Binding.R2 (R2Bucket(..))
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.HTTP
import WorkersSupport.Interop (responseToJSVal)
import Cloudflare.Workers.URL (parseURL)
import GHC.Wasm.Prim (JSVal)
import ApiCatalog.Attachments (attachmentHandler)

attachmentMissingReader :: JSVal -> IO JSVal
attachmentMissingReader native = do
  url <- maybe (fail "Invalid attachment fixture URL") pure (parseURL "https://api-catalog.invalid/attachments/missing-reader")
  let request = Request PUT url Nothing (headersFromList []) Nothing Nothing
  attachmentHandler (R2Bucket native) Nothing ["missing-reader"] request >>= responseToJSVal

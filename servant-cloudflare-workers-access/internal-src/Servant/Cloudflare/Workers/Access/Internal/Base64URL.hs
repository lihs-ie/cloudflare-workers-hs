module Servant.Cloudflare.Workers.Access.Internal.Base64URL (
    decodeBase64URL,
) where

import Data.ByteString (ByteString)
import Data.ByteString.Base64.URL qualified as Base64URL
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding

decodeBase64URL :: Text -> Either Text ByteString
decodeBase64URL base64URLText =
    either (Left . createMalformedMessage) Right (Base64URL.decodeUnpadded (TextEncoding.encodeUtf8 base64URLText))
  where
    createMalformedMessage underlyingMessage = "malformed base64URL: " <> Text.pack underlyingMessage

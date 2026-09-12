module Cloudflare.Workers.Binding.Secret (
    Secret (..),
    revealSecret,
    redactedSecretText,
) where

import Data.Text (Text)
import Data.Text qualified as Text

newtype Secret = Secret Text
    deriving stock (Eq)

instance Show Secret where
    show _ = Text.unpack redactedSecretText

revealSecret :: Secret -> Text
revealSecret (Secret value) = value

redactedSecretText :: Text
redactedSecretText = "Secret <redacted>"

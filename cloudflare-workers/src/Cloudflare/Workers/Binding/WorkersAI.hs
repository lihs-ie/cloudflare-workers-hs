module Cloudflare.Workers.Binding.WorkersAI (
    WorkersAI,
    AIModel (..),
    AIOptions,
    defaultAIOptions,
    WorkersAIError (..),
    workersAIModelName,
    workersAIRun,
) where

import Cloudflare.Workers.Binding.WorkersAI.Gemma (GemmaInput, GemmaOutput)
import Cloudflare.Workers.Internal.FFI.WorkersAI (WorkersAIFailure (..), runWorkersAIJSONViaFFI)
import Cloudflare.Workers.Internal.WorkersAI (WorkersAI (WorkersAI))
import Control.Exception (Exception, throwIO)
import Data.Aeson (ToJSON (..), eitherDecodeStrict', encode, object)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8, encodeUtf8)

data AIModel = Gemma4 deriving stock (Show, Eq)

data AIOptions = AIOptions deriving stock (Show, Eq)

defaultAIOptions :: AIOptions
defaultAIOptions = AIOptions

instance ToJSON AIOptions where
    toJSON _ = object []

data WorkersAIError
    = WorkersAIException Text (Maybe Text)
    | WorkersAIInvalidInput Text
    | WorkersAIInvalidResponse Text
    deriving stock (Show, Eq)

instance Exception WorkersAIError

workersAIModelName :: AIModel -> Text
workersAIModelName Gemma4 = "@cf/google/gemma-4-26b-a4b-it"

workersAIRun :: WorkersAI -> AIModel -> GemmaInput -> AIOptions -> IO GemmaOutput
workersAIRun (WorkersAI binding) model input options = do
    result <- runWorkersAIJSONViaFFI binding (workersAIModelName model) (encodeText input) (encodeText options) Nothing
    case result of
        Left (WorkersAIProviderFailure message name) -> throwIO (WorkersAIException message name)
        Left (WorkersAIInputFailure message) -> throwIO (WorkersAIInvalidInput message)
        Left (WorkersAIResultFailure message) -> throwIO (WorkersAIInvalidResponse message)
        Right payload -> case eitherDecodeStrict' (encodeUtf8 payload) of
            Left message -> throwIO (WorkersAIInvalidResponse (Text.pack message))
            Right output -> pure output

encodeText :: (ToJSON a) => a -> Text
encodeText = decodeUtf8 . LazyByteString.toStrict . encode

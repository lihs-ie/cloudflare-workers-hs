module Cloudflare.Workers.Binding.WorkersAI (
    WorkersAI,
    AIModel (..),
    AIOptions,
    defaultAIOptions,
    WorkersAIError (..),
    workersAIModelName,
    workersAIRun,
    StructuredInput (..),
    StructuredMessage (..),
) where

import Cloudflare.Workers.Binding.WorkersAI.Gemma (GemmaInput, GemmaOutput)
import Cloudflare.Workers.Internal.FFI.WorkersAI (WorkersAIFailure (..), runWorkersAIJSONViaFFI)
import Cloudflare.Workers.Internal.WorkersAI (WorkersAI (WorkersAI))
import Control.Exception (Exception, throwIO)
import Data.Aeson (
    FromJSON (parseJSON),
    ToJSON (..),
    Value,
    eitherDecodeStrict',
    encode,
    object,
    withObject,
    (.:),
    (.=),
 )
import Data.Aeson.Types (Parser, parseEither)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.List.NonEmpty (NonEmpty)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8, encodeUtf8)

data AIModel input output where
    Gemma4 :: AIModel GemmaInput GemmaOutput
    Llama33 :: AIModel StructuredInput Value

deriving stock instance Show (AIModel input output)
deriving stock instance Eq (AIModel input output)

data AIOptions = AIOptions deriving stock (Show, Eq)

data StructuredMessage
    = StructuredSystem Text
    | StructuredUser Text
    | StructuredAssistant Text
    deriving stock (Show, Eq)

instance ToJSON StructuredMessage where
    toJSON (StructuredSystem content) = structuredMessage "system" content
    toJSON (StructuredUser content) = structuredMessage "user" content
    toJSON (StructuredAssistant content) = structuredMessage "assistant" content

data StructuredInput = StructuredInput
    { structuredInputMessages :: NonEmpty StructuredMessage
    , structuredInputSchema :: Value
    }
    deriving stock (Show, Eq)

structuredMessage :: Text -> Text -> Value
structuredMessage role content = object ["role" .= role, "content" .= content]

instance ToJSON StructuredInput where
    toJSON input =
        object
            [ "messages" .= structuredInputMessages input
            , "stream" .= False
            , "response_format" .= object ["type" .= Text.pack "json_schema", "json_schema" .= structuredInputSchema input]
            ]

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

workersAIModelName :: AIModel input output -> Text
workersAIModelName Gemma4 = "@cf/google/gemma-4-26b-a4b-it"
workersAIModelName Llama33 = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"

workersAIRun :: WorkersAI -> AIModel input output -> input -> AIOptions -> IO output
workersAIRun binding model input options = case model of
    Gemma4 -> runModel binding model input options parseJSON
    Llama33 -> runModel binding model input options (withObject "JSON Mode response" (.: "response"))

runModel :: (ToJSON input) => WorkersAI -> AIModel input output -> input -> AIOptions -> (Value -> Parser output) -> IO output
runModel (WorkersAI binding) model input options parseOutput = do
    result <- runWorkersAIJSONViaFFI binding (workersAIModelName model) (encodeText input) (encodeText options) Nothing
    case result of
        Left (WorkersAIProviderFailure message name) -> throwIO (WorkersAIException message name)
        Left (WorkersAIInputFailure message) -> throwIO (WorkersAIInvalidInput message)
        Left (WorkersAIResultFailure message) -> throwIO (WorkersAIInvalidResponse message)
        Right payload -> case eitherDecodeStrict' (encodeUtf8 payload) >>= parseEither parseOutput of
            Left message -> throwIO (WorkersAIInvalidResponse (Text.pack message))
            Right output -> pure output

encodeText :: (ToJSON a) => a -> Text
encodeText = decodeUtf8 . LazyByteString.toStrict . encode

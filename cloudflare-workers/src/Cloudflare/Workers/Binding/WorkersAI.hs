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
    FluxSchnellInput (..),
    LucidOriginInput (..),
    PhoenixInput (..),
    Base64Image,
    base64ImageText,
    base64ImageBytes,
) where

import Cloudflare.Workers.Binding.WorkersAI.Gemma (GemmaInput, GemmaOutput)
import Cloudflare.Workers.Internal.FFI.WorkersAI (WorkersAIFailure (..), runWorkersAIJSONViaFFI)
import Cloudflare.Workers.Internal.Streaming (ReadableStream)
import Cloudflare.Workers.Internal.WorkersAI (WorkersAI (WorkersAI))
import Cloudflare.Workers.Internal.WorkersAI.Image (
    Base64Image,
    FluxSchnellInput (..),
    LucidOriginInput (..),
    PhoenixInput (..),
    base64ImageBytes,
    base64ImageText,
    parseBase64Image,
 )
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
import Data.Word (Word64)
import GHC.Base (bindIO)

data AIModel input output where
    Gemma4 :: AIModel GemmaInput GemmaOutput
    Llama33 :: AIModel StructuredInput Value
    FluxSchnell :: AIModel FluxSchnellInput Base64Image
    LucidOrigin :: AIModel LucidOriginInput Base64Image
    Phoenix10 :: AIModel PhoenixInput ReadableStream

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
workersAIModelName FluxSchnell = "@cf/black-forest-labs/flux-1-schnell"
workersAIModelName LucidOrigin = "@cf/leonardo/lucid-origin"
workersAIModelName Phoenix10 = "@cf/leonardo/phoenix-1.0"

workersAIRun :: WorkersAI -> AIModel input output -> input -> AIOptions -> IO output
workersAIRun binding model input options = case model of
    Gemma4 -> runJSONModel binding model input options parseJSON
    Llama33 -> runJSONModel binding model input options (withObject "JSON Mode response" (.: "response"))
    FluxSchnell -> runJSONModel binding model input options parseBase64Image
    LucidOrigin -> do
        validateImageSeed (lucidSeed input)
        runJSONModel binding model input options parseBase64Image
    Phoenix10 -> do
        validateImageSeed (phoenixSeed input)
        runStreamModel binding model input options

validateImageSeed :: Maybe Word64 -> IO ()
validateImageSeed seed = do
    case seed of
        Just value | value > maxSafeJavaScriptInteger -> throwIO (WorkersAIInvalidInput "Image seed exceeds the JavaScript safe integer range")
        _ -> pure ()
  where
    maxSafeJavaScriptInteger :: Word64
    maxSafeJavaScriptInteger = 9007199254740991

runJSONModel :: (ToJSON input) => WorkersAI -> AIModel input output -> input -> AIOptions -> (Value -> Parser output) -> IO output
runJSONModel (WorkersAI binding) model input options parseOutput = do
    result <- runWorkersAIJSONViaFFI binding (workersAIModelName model) (encodeText input) (encodeText options) Nothing
    payload <- unwrapResult result
    case eitherDecodeStrict' (encodeUtf8 payload) >>= parseEither parseOutput of
        Left message -> throwIO (WorkersAIInvalidResponse (Text.pack message))
        Right output -> pure output

runStreamModel :: WorkersAI -> AIModel PhoenixInput ReadableStream -> PhoenixInput -> AIOptions -> IO ReadableStream
runStreamModel (WorkersAI binding) model input options =
    runWorkersAIStreamViaFFI binding (workersAIModelName model) (encodeText input) (encodeText options) Nothing
        >>= unwrapResult

unwrapResult :: Either WorkersAIFailure output -> IO output
unwrapResult result = case result of
    Left (WorkersAIProviderFailure message name) -> throwIO (WorkersAIException message name)
    Left (WorkersAIInputFailure message) -> throwIO (WorkersAIInvalidInput message)
    Left (WorkersAIResultFailure message) -> throwIO (WorkersAIInvalidResponse message)
    Right output -> pure output

encodeText :: (ToJSON a) => a -> Text
encodeText = decodeUtf8 . LazyByteString.toStrict . encode

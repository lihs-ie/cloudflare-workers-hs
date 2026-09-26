module Cloudflare.Workers.Binding.WorkersAI.Gemma (
    GemmaInput (..),
    GemmaMessage (..),
    GemmaOutput (..),
    GemmaChatChoice (..),
    GemmaTextChoice (..),
    GemmaResponseMessage (..),
) where

import Data.Aeson (
    FromJSON (parseJSON),
    ToJSON (toJSON),
    Value,
    object,
    withObject,
    (.:),
    (.=),
 )
import Data.List.NonEmpty (NonEmpty)
import Data.Text (Text)

data GemmaMessage
    = GemmaSystem Text
    | GemmaUser Text
    | GemmaAssistant Text
    deriving stock (Show, Eq)

data GemmaInput
    = GemmaPrompt Text
    | GemmaMessages (NonEmpty GemmaMessage)
    deriving stock (Show, Eq)

instance ToJSON GemmaInput where
    toJSON (GemmaPrompt prompt) = object ["prompt" .= prompt, "stream" .= False]
    toJSON (GemmaMessages messages) = object ["messages" .= messages, "stream" .= False]

message :: Text -> Text -> Value
message role content = object ["role" .= role, "content" .= content]

instance ToJSON GemmaMessage where
    toJSON (GemmaSystem content) = message "system" content
    toJSON (GemmaUser content) = message "user" content
    toJSON (GemmaAssistant content) = message "assistant" content

newtype GemmaResponseMessage = GemmaResponseMessage
    { gemmaResponseContent :: Maybe Text
    }
    deriving stock (Show, Eq)

data GemmaChatChoice = GemmaChatChoice
    { gemmaChatChoiceIndex :: Integer
    , gemmaChatChoiceMessage :: GemmaResponseMessage
    }
    deriving stock (Show, Eq)

data GemmaTextChoice = GemmaTextChoice
    { gemmaTextChoiceIndex :: Integer
    , gemmaTextChoiceText :: Text
    }
    deriving stock (Show, Eq)

data GemmaOutput
    = GemmaChatOutput
        { identifier :: Text
        , gemmaChatChoices :: NonEmpty GemmaChatChoice
        }
    | GemmaTextOutput
        { identifier :: Text
        , gemmaTextChoices :: NonEmpty GemmaTextChoice
        }
    deriving stock (Show, Eq)

instance FromJSON GemmaOutput where
    parseJSON = withObject "GemmaOutput" $ \value -> do
        kind <- value .: "object"
        case kind :: Text of
            "chat.completion" -> GemmaChatOutput <$> value .: "id" <*> value .: "choices"
            "text_completion" -> GemmaTextOutput <$> value .: "id" <*> value .: "choices"
            _ -> fail "Unsupported Gemma output object"

instance FromJSON GemmaChatChoice where
    parseJSON = withObject "GemmaChatChoice" $ \value ->
        GemmaChatChoice <$> value .: "index" <*> value .: "message"

instance FromJSON GemmaTextChoice where
    parseJSON = withObject "GemmaTextChoice" $ \value ->
        GemmaTextChoice <$> value .: "index" <*> value .: "text"

instance FromJSON GemmaResponseMessage where
    parseJSON = withObject "GemmaResponseMessage" $ \value -> do
        role <- value .: "role"
        if role == ("assistant" :: Text)
            then GemmaResponseMessage <$> value .: "content"
            else fail "Gemma response message must have assistant role"

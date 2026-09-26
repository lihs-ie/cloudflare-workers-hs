module Cloudflare.Workers.Binding.WorkersAI.Gemma (
    GemmaInput (..),
    GemmaMessage (..),
    GemmaOutput (..),
    GemmaChoice (..),
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

data GemmaChoice = GemmaChoice
    { gemmaChoiceIndex :: Integer
    , gemmaChoiceMessage :: GemmaResponseMessage
    }
    deriving stock (Show, Eq)

data GemmaOutput = GemmaOutput
    { identifier :: Text
    , gemmaChoices :: NonEmpty GemmaChoice
    }
    deriving stock (Show, Eq)

instance FromJSON GemmaOutput where
    parseJSON = withObject "GemmaOutput" $ \value ->
        GemmaOutput <$> value .: "id" <*> value .: "choices"

instance FromJSON GemmaChoice where
    parseJSON = withObject "GemmaChoice" $ \value ->
        GemmaChoice <$> value .: "index" <*> value .: "message"

instance FromJSON GemmaResponseMessage where
    parseJSON = withObject "GemmaResponseMessage" $ \value -> do
        role <- value .: "role"
        if role == ("assistant" :: Text)
            then GemmaResponseMessage <$> value .: "content"
            else fail "Gemma response message must have assistant role"

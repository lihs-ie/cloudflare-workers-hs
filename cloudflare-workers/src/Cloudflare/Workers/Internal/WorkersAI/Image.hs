module Cloudflare.Workers.Internal.WorkersAI.Image (
    FluxSchnellInput (..),
    LucidOriginInput (..),
    PhoenixInput (..),
    Base64Image,
    base64ImageText,
    base64ImageBytes,
    parseBase64Image,
) where

import Data.Aeson (
    Key,
    ToJSON (toJSON),
    Value,
    object,
    withObject,
    (.:),
    (.=),
 )
import Data.Aeson.Types (Pair, Parser)
import Data.ByteString (ByteString)
import Data.ByteString.Base64 qualified as Base64
import Data.Text (Text)
import Data.Text.Encoding (encodeUtf8)
import Data.Word (Word64)

data FluxSchnellInput = FluxSchnellInput
    { fluxPrompt :: Text
    , fluxSteps :: Maybe Int
    }
    deriving stock (Show, Eq)

instance ToJSON FluxSchnellInput where
    toJSON input =
        object (("prompt" .= fluxPrompt input) : optional "steps" (fluxSteps input))

data LucidOriginInput = LucidOriginInput
    { lucidPrompt :: Text
    , lucidSteps :: Maybe Int
    , lucidWidth :: Maybe Int
    , lucidHeight :: Maybe Int
    , lucidSeed :: Maybe Word64
    }
    deriving stock (Show, Eq)

instance ToJSON LucidOriginInput where
    toJSON input =
        object $
            ("prompt" .= lucidPrompt input)
                : concat
                    [ optional "steps" (lucidSteps input)
                    , optional "width" (lucidWidth input)
                    , optional "height" (lucidHeight input)
                    , optional "seed" (lucidSeed input)
                    ]

instance ToJSON PhoenixInput where
    toJSON input =
        object $
            ("prompt" .= phoenixPrompt input)
                : concat
                    [ optional "num_steps" (phoenixSteps input)
                    , optional "width" (phoenixWidth input)
                    , optional "height" (phoenixHeight input)
                    , optional "seed" (phoenixSeed input)
                    ]

data PhoenixInput = PhoenixInput
    { phoenixPrompt :: Text
    , phoenixSteps :: Maybe Int
    , phoenixWidth :: Maybe Int
    , phoenixHeight :: Maybe Int
    , phoenixSeed :: Maybe Word64
    }
    deriving stock (Show, Eq)

optional :: (ToJSON value) => Key -> Maybe value -> [Pair]
optional key = maybe [] (\value -> [key .= value])

data Base64Image = Base64Image !Text !ByteString

base64ImageText :: Base64Image -> Text
base64ImageText (Base64Image text _) = text

base64ImageBytes :: Base64Image -> ByteString
base64ImageBytes (Base64Image _ bytes) = bytes

parseBase64Image :: Value -> Parser Base64Image
parseBase64Image = withObject "Workers AI image response" $ \response -> do
    image <- response .: "image"
    case Base64.decode (encodeUtf8 image) of
        Left message -> fail ("Invalid Base64 image: " <> message)
        Right bytes -> pure (Base64Image image bytes)

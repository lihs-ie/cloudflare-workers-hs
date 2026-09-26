module Cloudflare.Workers.Binding.WorkersAISpec (spec) where

import Cloudflare.Workers.Binding.WorkersAI
import Cloudflare.Workers.Binding.WorkersAI.Gemma
import Data.Aeson (Value, eitherDecode, object, toJSON, (.=))
import Data.List.NonEmpty (NonEmpty (..))
import Test.Syd

spec :: Spec
spec = do
    it "encodes a prompt without enabling streaming" $
        toJSON (GemmaPrompt "hello") `shouldBe` object ["prompt" .= ("hello" :: String), "stream" .= False]

    it "encodes text conversation roles in Cloudflare's messages form" $
        toJSON (GemmaMessages (GemmaSystem "brief" :| [GemmaUser "hello", GemmaAssistant "hi"]))
            `shouldBe` object
                ["messages" .= [object ["role" .= ("system" :: String), "content" .= ("brief" :: String)], object ["role" .= ("user" :: String), "content" .= ("hello" :: String)], object ["role" .= ("assistant" :: String), "content" .= ("hi" :: String)]], "stream" .= False]

    it "decodes multiple choices and preserves a null body" $ do
        let result = eitherDecode @GemmaOutput "{\"id\":\"completion-1\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"hello\"}},{\"index\":1,\"message\":{\"role\":\"assistant\",\"content\":null}}]}"
        result `shouldBe` Right (GemmaOutput "completion-1" (GemmaChoice 0 (GemmaResponseMessage (Just "hello")) :| [GemmaChoice 1 (GemmaResponseMessage Nothing)]))

    it "rejects a result without choices" $
        (eitherDecode @GemmaOutput "{\"id\":\"completion-1\",\"choices\":[]}" :: Either String GemmaOutput)
            `shouldSatisfy` either (const True) (const False)

    it "fixes the supported model name" $
        workersAIModelName Gemma4 `shouldBe` "@cf/google/gemma-4-26b-a4b-it"

    it "keeps the default third argument empty" $
        toJSON defaultAIOptions `shouldBe` (object [] :: Value)

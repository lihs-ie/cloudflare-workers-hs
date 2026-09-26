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
        let result = eitherDecode @GemmaOutput "{\"id\":\"completion-1\",\"object\":\"chat.completion\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"hello\"}},{\"index\":1,\"message\":{\"role\":\"assistant\",\"content\":null}}]}"
        result `shouldBe` Right (GemmaChatOutput "completion-1" (GemmaChatChoice 0 (GemmaResponseMessage (Just "hello")) :| [GemmaChatChoice 1 (GemmaResponseMessage Nothing)]))

    it "decodes a prompt as Cloudflare's text_completion with text choices" $ do
        let result = eitherDecode @GemmaOutput "{\"id\":\"cmpl-1\",\"object\":\"text_completion\",\"choices\":[{\"index\":0,\"text\":\"hello world\",\"finish_reason\":\"stop\"}]}"
        result `shouldBe` Right (GemmaTextOutput "cmpl-1" (GemmaTextChoice 0 "hello world" :| []))

    it "rejects a result without choices" $
        (eitherDecode @GemmaOutput "{\"id\":\"completion-1\",\"object\":\"chat.completion\",\"choices\":[]}" :: Either String GemmaOutput)
            `shouldSatisfy` either (const True) (const False)

    it "rejects an unsupported completion object" $
        (eitherDecode @GemmaOutput "{\"id\":\"completion-1\",\"object\":\"other\",\"choices\":[{\"index\":0,\"text\":\"hello\"}]}" :: Either String GemmaOutput)
            `shouldSatisfy` either (const True) (const False)

    it "fixes the supported model name" $
        workersAIModelName Gemma4 `shouldBe` "@cf/google/gemma-4-26b-a4b-it"

    it "keeps the default third argument empty" $
        toJSON defaultAIOptions `shouldBe` (object [] :: Value)

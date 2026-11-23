module Support.Runtime.WorkersAI (probeWorkersAI) where

import Cloudflare.Workers.Binding.WorkersAI (
    AIModel (Gemma4, Llama33),
    StructuredInput (StructuredInput),
    StructuredMessage (StructuredSystem, StructuredUser),
    WorkersAI,
    WorkersAIError,
    defaultAIOptions,
    workersAIRun,
 )
import Cloudflare.Workers.Binding.WorkersAI.Gemma (
    GemmaChatChoice (gemmaChatChoiceIndex, gemmaChatChoiceMessage),
    GemmaInput (GemmaMessages, GemmaPrompt),
    GemmaMessage (GemmaAssistant, GemmaSystem, GemmaUser),
    GemmaOutput (GemmaChatOutput, GemmaTextOutput),
    GemmaResponseMessage (gemmaResponseContent),
    GemmaTextChoice (gemmaTextChoiceIndex, gemmaTextChoiceText),
 )
import Cloudflare.Workers.Entrypoint.Fetch (FetchHandler, createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Cloudflare.Workers.HTTP (Response, ResponseBody (ResponseBodyLazyBytes), Status (Status), createResponse, requestPath)
import Cloudflare.Workers.Headers (headersFromList)
import Control.Exception (try)
import Data.Aeson (Value, encode, object, (.=))
import Data.List.NonEmpty (NonEmpty ((:|)))
import Data.Proxy (Proxy (Proxy))
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

type ProbeBindings = '[ '("AI", WorkersAI)]

probeWorkersAI :: JSVal -> JSVal -> JSVal -> IO JSVal
probeWorkersAI = createFetchHandler handleProbe

handleProbe :: FetchHandler (BindingEnv '[] '[] ProbeBindings)
handleProbe request env _context = do
    let binding = getBinding (Proxy @"AI") env
        command = Text.drop (Text.length "/__fixture/workers-ai/") (requestPath request)
    result <- case command of
        "structured-object" -> runStructured binding cityInput
        "structured-array" -> runStructured binding rankingInput
        _ -> runGemma binding command
    pure (json result)

runGemma :: WorkersAI -> Text.Text -> IO Value
runGemma binding command = do
    let input = case command of
            "prompt" -> GemmaPrompt "hello"
            "messages" -> GemmaMessages (GemmaSystem "Be brief" :| [GemmaUser "hello", GemmaAssistant "hi"])
            _ -> GemmaPrompt "hello"
    outcome <- try @WorkersAIError (workersAIRun binding Gemma4 input defaultAIOptions)
    pure $ case outcome of
        Right (GemmaChatOutput outputIdentifier choices) ->
            object ["ok" .= True, "identifier" .= outputIdentifier, "object" .= ("chat.completion" :: Text.Text), "choices" .= fmap chatChoiceValue choices]
        Right (GemmaTextOutput outputIdentifier choices) ->
            object ["ok" .= True, "identifier" .= outputIdentifier, "object" .= ("text_completion" :: Text.Text), "choices" .= fmap textChoiceValue choices]
        Left failure -> object ["ok" .= False, "failure" .= show failure]

runStructured :: WorkersAI -> StructuredInput -> IO Value
runStructured binding input = do
    outcome <- try @WorkersAIError (workersAIRun binding Llama33 input defaultAIOptions)
    pure $ case outcome of
        Right response -> object ["ok" .= True, "response" .= response]
        Left failure -> object ["ok" .= False, "failure" .= show failure]

cityInput :: StructuredInput
cityInput =
    StructuredInput
        (StructuredSystem "Use the supplied schema" :| [StructuredUser "Describe Kyoto"])
        ( object
            [ "type" .= ("object" :: Text.Text)
            , "properties" .= object ["city" .= object ["type" .= ("string" :: Text.Text)]]
            , "required" .= (["city"] :: [Text.Text])
            ]
        )

rankingInput :: StructuredInput
rankingInput =
    StructuredInput
        (StructuredUser "Return the rankings" :| [])
        (object ["type" .= ("array" :: Text.Text), "items" .= object ["type" .= ("integer" :: Text.Text)]])

chatChoiceValue :: GemmaChatChoice -> Value
chatChoiceValue choice = object ["index" .= gemmaChatChoiceIndex choice, "content" .= gemmaResponseContent (gemmaChatChoiceMessage choice)]

textChoiceValue :: GemmaTextChoice -> Value
textChoiceValue choice = object ["index" .= gemmaTextChoiceIndex choice, "text" .= gemmaTextChoiceText choice]

json :: Value -> Response
json value =
    createResponse
        (Status 200)
        (headersFromList [("content-type", "application/json")])
        (ResponseBodyLazyBytes (encode value))

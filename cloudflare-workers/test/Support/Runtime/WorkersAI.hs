module Support.Runtime.WorkersAI (probeWorkersAI) where

import Cloudflare.Workers.Binding.WorkersAI
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
import Cloudflare.Workers.HTTP (Response, ResponseBody (ResponseBodyLazyBytes, ResponseBodyStream), Status (Status), createResponse, requestPath)
import Cloudflare.Workers.Headers (headersFromList)
import Control.Exception (try)
import Data.Aeson (Value, encode, object, (.=))
import Data.ByteString qualified as ByteString
import Data.List.NonEmpty
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
    case command of
        "structured-object" -> json <$> runStructured binding cityInput
        "structured-array" -> json <$> runStructured binding rankingInput
        "flux" -> runImage binding FluxSchnell (FluxSchnellInput "A red bicycle" (Just 4))
        "flux-defaults" -> runImage binding FluxSchnell (FluxSchnellInput "A red bicycle" Nothing)
        "lucid" -> runImage binding LucidOrigin (LucidOriginInput "A forest at dawn" (Just 12) (Just 768) (Just 512) (Just 3000000000))
        "lucid-unsafe-seed" -> runImage binding LucidOrigin (LucidOriginInput "A forest at dawn" Nothing Nothing Nothing (Just 9007199254740992))
        "lucid-defaults" -> runImage binding LucidOrigin (LucidOriginInput "A forest at dawn" Nothing Nothing Nothing Nothing)
        "phoenix" -> runPhoenix binding (PhoenixInput "A lighthouse at dusk" (Just 25) (Just 1024) (Just 768) (Just 7))
        "phoenix-defaults" -> runPhoenix binding (PhoenixInput "A lighthouse at dusk" Nothing Nothing Nothing Nothing)
        _ -> json <$> runGemma binding command

runImage :: WorkersAI -> AIModel input Base64Image -> input -> IO Response
runImage binding model input = do
    outcome <- try @WorkersAIError (workersAIRun binding model input defaultAIOptions)
    pure $ json $ case outcome of
        Right image -> object ["image" .= base64ImageText image, "bytes" .= ByteString.unpack (base64ImageBytes image)]
        Left failure -> failureValue failure

runPhoenix :: WorkersAI -> PhoenixInput -> IO Response
runPhoenix binding input = do
    outcome <- try @WorkersAIError (workersAIRun binding Phoenix10 input defaultAIOptions)
    pure $ case outcome of
        Right stream -> createResponse (Status 200) (headersFromList [("content-type", "application/octet-stream")]) (ResponseBodyStream stream)
        Left failure -> json (failureValue failure)

failureValue :: WorkersAIError -> Value
failureValue failure = object ["ok" .= False, "failure" .= show failure]


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
        Left failure -> failureValue failure

runStructured :: WorkersAI -> StructuredInput -> IO Value
runStructured binding input = do
    outcome <- try @WorkersAIError (workersAIRun binding Llama33 input defaultAIOptions)
    pure $ case outcome of
        Right response -> object ["ok" .= True, "response" .= response]
        Left failure -> failureValue failure

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

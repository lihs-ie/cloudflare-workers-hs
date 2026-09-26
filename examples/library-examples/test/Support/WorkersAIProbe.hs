module Support.WorkersAIProbe (probeWorkersAI) where

import Cloudflare.Workers.Binding.WorkersAI
import Cloudflare.Workers.Binding.WorkersAI.Gemma (GemmaChoice (gemmaChoiceIndex, gemmaChoiceMessage), GemmaInput (GemmaMessages, GemmaPrompt), GemmaMessage (GemmaAssistant, GemmaSystem, GemmaUser), GemmaOutput (gemmaChoices, identifier), GemmaResponseMessage (gemmaResponseContent))
import Cloudflare.Workers.Entrypoint.Fetch (FetchHandler, createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Cloudflare.Workers.HTTP (Response, ResponseBody (ResponseBodyLazyBytes), Status (Status), createResponse, requestPath)
import Cloudflare.Workers.Headers (headersFromList)
import Control.Exception (try)
import Data.Aeson (Value, encode, object, (.=))
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
        input = case command of
            "prompt" -> GemmaPrompt "hello"
            "messages" -> GemmaMessages (GemmaSystem "Be brief" :| [GemmaUser "hello", GemmaAssistant "h1"])
            _ -> GemmaPrompt "hello"
    outcome <- try @WorkersAIError (workersAIRun binding Gemma4 input defaultAIOptions)
    pure $ json $ case outcome of
        Right output -> object ["ok" .= True, "identifier" .= identifier output, "choice" .= fmap choiceValue (gemmaChoices output)]
        Left failure -> object ["ok" .= False, "failure" .= show failure]

choiceValue :: GemmaChoice -> Value
choiceValue choice = object ["index" .= gemmaChoiceIndex choice, "content" .= gemmaResponseContent (gemmaChoiceMessage choice)]

json :: Value -> Response
json value =
    createResponse
        (Status 200)
        (headersFromList [("content-type", "application/json")])
        (ResponseBodyLazyBytes (encode value))

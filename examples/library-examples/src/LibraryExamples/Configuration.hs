module LibraryExamples.Configuration
    ( ConfigurationBindings, Settings, settingsFromBindings, configurationSummary
    , instrumented
    ) where

import Cloudflare.Workers.Binding.Secret (Secret, revealSecret)
import Cloudflare.Workers.Binding.Var (Var, unVar)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Cloudflare.Workers.Headers (headerInsert, headerLookup, headersFromList)
import Cloudflare.Workers.HTTP (Request(..), Response(..), Status(..), ResponseBody(..), createResponse)
import Cloudflare.Workers.Middleware (Middleware, withRequestId, withStructuredLogging)
import Cloudflare.Workers.Observability (defaultLoggerConfig, tailLog)
import Control.Exception (SomeException, catch)
import Data.Aeson (Value, object, (.=))
import Data.Proxy (Proxy(..))
import Data.Text (Text)
import Data.Text qualified as Text

type ConfigurationBindings = BindingEnv '[] '[] '[ '("EXAMPLE_MODE", Var), '("EXAMPLE_SECRET", Secret)]
data Settings = Settings Var Secret

settingsFromBindings :: ConfigurationBindings -> Settings
settingsFromBindings bindings = Settings (getBinding (Proxy @"EXAMPLE_MODE") bindings) (getBinding (Proxy @"EXAMPLE_SECRET") bindings)

-- Only capability results are exposed. Neither configuration values nor secret
-- material are echoed; the Secret Show instance is separately checked here.
configurationSummary :: Settings -> Value
configurationSummary (Settings mode secret) = object
    [ "configured" .= (not (Text.null (unVar mode)) && not (Text.null (revealSecret secret)))
    , "secretRedacted" .= (show secret == "Secret <redacted>")
    ]

-- Catch at the application boundary before generic logging can see exception
-- text. The outer middleware still records status and duration for failed work.
instrumented :: Middleware env
instrumented handler = withRequestId $ withStructuredLogging defaultLoggerConfig $ \request env context -> do
    response <- handler request env context `catch` \(_ :: SomeException) -> do
        tailLog "configuration_application_failed"
        pure (createResponse (Status 500) (headersFromList [("content-type", "application/json")])
            (ResponseBodyBytes "{\"error\":\"internal_error\"}"))
    let identifier = maybe "unknown" id (headerLookup "x-hs-request-id" (requestHeaders request))
    pure response {responseHeaders = headerInsert "x-request-identifier" identifier (responseHeaders response)}


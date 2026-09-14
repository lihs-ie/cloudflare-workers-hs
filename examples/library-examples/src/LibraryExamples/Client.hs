-- | Typed internal requests with bounded retries and explicit failure handling.
-- Supplying an idempotency key does not make a POST automatically retryable.
-- Applications performing mutations must enforce the key atomically at the
-- destination; this stateless echo example verifies transport preservation only.
module LibraryExamples.Client
    ( ClientTargetAPI, ClientTargetRoutes (..), clientTargetServer, clientPolicyExample
    , ExampleClientOptions, defaultExampleClientOptions, mkExampleClientOptions, clientOptionsExample, clientStreamingExample
    ) where

import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding)
import Control.Exception (fromException, try)
import Data.Aeson (Value, eitherDecode, object, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Data.Text.Encoding (decodeUtf8)
import GHC.Generics (Generic)
import Network.HTTP.Types.Status (statusCode)
import Servant.API
import Servant.API.Generic ((:-))
import Servant.Types.SourceT qualified as SourceT
import Servant.Client.Core (BaseUrl (..), ClientError (..), ResponseF (..), Scheme (..), RequestF (..), RequestBody (..), clientIn, defaultRequest)
import Servant.Cloudflare.Workers.Client.Fetch
    ( FetchClient, FetchTransportError, fetchTransportErrorConstructorName, runFetchClientWithServiceBinding
    , FetchClientOptions (..), fetchWithOptions )
import Servant.Cloudflare.Workers.Server (Server)

-- Mounted under /client-target in the Worker. The test boundary injects lost
-- connections and malformed responses while successful requests reach this
-- actual Haskell Servant handler through a real Service Binding.
data ClientTargetRoutes mode = ClientTargetRoutes
    { clientRetry :: mode :- "retry" :> Header "Idempotency-Key" Text :> ReqBody '[JSON] Text :> Put '[JSON] Value
    , clientNoRetry :: mode :- "no-retry" :> Header "Idempotency-Key" Text :> ReqBody '[JSON] Text :> Post '[JSON] Value
    , clientMalformed :: mode :- "malformed" :> Get '[JSON] Value
    , clientExhausted :: mode :- "exhausted" :> Get '[JSON] Value
    } deriving stock (Generic)

type ClientTargetAPI = NamedRoutes ClientTargetRoutes

clientTargetServer :: Server ClientTargetAPI env
clientTargetServer = ClientTargetRoutes
    { clientRetry = echoPayload
    , clientNoRetry = echoPayload
    , clientMalformed = pure (object ["valid" .= True])
    , clientExhausted = pure (object ["connected" .= True])
    }
  where
    echoPayload key payload = pure (object ["key" .= key, "payload" .= payload])

clientPolicyExample :: ServiceBinding -> IO Value
clientPolicyExample binding = do
    let client = clientIn (Proxy @ClientTargetAPI) (Proxy @FetchClient)
        run action = runFetchClientWithServiceBinding action binding (BaseUrl Http "guide.internal" 80 "/client-target")
    retried <- try @ClientError (run (clientRetry client (Just "client-example-stable-key") "stable payload"))
    mutation <- try @ClientError (run (clientNoRetry client (Just "client-example-post-key") "mutation payload"))
    malformed <- try @ClientError (run (clientMalformed client))
    exhausted <- try @ClientError (run (clientExhausted client))
    pure (object
        [ "retry" .= describeOutcome retried
        , "post" .= describeOutcome mutation
        , "malformed" .= describeOutcome malformed
        , "exhausted" .= describeOutcome exhausted
        ])

describeOutcome :: Either ClientError Value -> Value
describeOutcome (Right value) = object ["result" .= value]
describeOutcome (Left failure) = case failure of
    DecodeFailure message response -> object
        [ "error" .= ("DecodeFailure" :: Text)
        , "message" .= message
        , "status" .= statusCode (responseStatusCode response)
        , "body" .= decodeUtf8 (Lazy.toStrict (responseBody response))
        ]
    ConnectionError exception -> object
        [ "error" .= ("ConnectionError" :: Text)
        , "transport" .= fmap fetchTransportErrorConstructorName (fromException @FetchTransportError exception)
        ]
    other -> object ["error" .= ("UnexpectedClientError" :: Text), "detail" .= show other]

-- | Validated application policy. The constructor is hidden so invalid values
-- cannot reach the transport. These application limits are deliberately tighter
-- than the transport's permissive normalization limits.
newtype ExampleClientOptions = ExampleClientOptions FetchClientOptions
    deriving stock (Show, Eq)

-- | Ten seconds per attempt, at most two retries, initially delayed by 250 ms.
-- A timeout is per attempt, not an overall deadline across retries.
defaultExampleClientOptions :: ExampleClientOptions
defaultExampleClientOptions = ExampleClientOptions (FetchClientOptions 10000 2 250)

-- | Reject invalid input instead of silently clamping it. At most three retries
-- bounds subrequests; the exponential delay is bounded by these small limits.
mkExampleClientOptions :: Int -> Int -> Int -> Either Text ExampleClientOptions
mkExampleClientOptions timeoutMillis retries delayMillis
    | timeoutMillis < 1 || timeoutMillis > 30000 = Left "timeoutMillis must be between 1 and 30000"
    | retries < 0 || retries > 3 = Left "retries must be between 0 and 3"
    | delayMillis < 0 || delayMillis > 1000 = Left "retryDelayMillis must be between 0 and 1000"
    | otherwise = Right (ExampleClientOptions (FetchClientOptions timeoutMillis retries delayMillis))

-- | Perform a buffered GET against an application-owned, fixed HTTP target.
-- The caller must not derive the target from untrusted request input. Unlike
-- Service Binding fetch, ordinary HTTP fetch supports the timeout here.
-- Only idempotent buffered requests retry transport failures; HTTP errors and
-- POST requests are not made retryable by supplying an idempotency key.
clientOptionsExample :: ExampleClientOptions -> BaseUrl -> IO Value
clientOptionsExample (ExampleClientOptions options) target = do
    outcome <- try @ClientError (fetchWithOptions options Nothing target defaultRequest)
    pure (object
        [ "timeoutMillis" .= fetchClientOptionsTimeoutMillis options
        , "maxRetryAttempts" .= fetchClientOptionsMaxRetryAttempts options
        , "retryBaseDelayMillis" .= fetchClientOptionsRetryBaseDelayMillis options
        , "timeoutScope" .= ("per-attempt" :: Text)
        , "outcome" .= describeOutcome (fmap (\response -> object ["status" .= statusCode (responseStatusCode response)]) outcome)
        ])

-- | Send a one-shot binary producer through the ordinary HTTP transport.
-- Keeping the body as a source exercises native streaming rather than buffering
-- the request before dispatch. Streaming bodies are never replayed on failure.
clientStreamingExample :: BaseUrl -> IO Value
clientStreamingExample target = do
    let chunks = map Lazy.pack [[0, 1], [127, 128, 255], [10, 42]]
        request = defaultRequest
            { requestMethod = "POST"
            , requestHeaders = pure ("X-Stream-Trace", "stream-regression")
            , requestBody = Just
                (RequestBodySource (SourceT.source chunks), contentType (Proxy @OctetStream))
            }
    outcome <- try @ClientError (fetchWithOptions (FetchClientOptions 1000 2 0) Nothing target request)
    case outcome of
        Left failure -> pure (describeOutcome (Left failure))
        Right response -> case eitherDecode (responseBody response) of
            Left message -> fail ("Invalid stream echo response: " <> message)
            Right value -> pure value

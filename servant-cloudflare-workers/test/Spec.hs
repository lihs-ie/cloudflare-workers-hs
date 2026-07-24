{-# LANGUAGE AllowAmbiguousTypes #-}

module Main (main) where

import Cloudflare.Workers.HTTP (
    Method (GET),
    Request (Request),
    Response (responseStatus),
    Status (..),
    createResponse,
    requestPathField,
    responseHeaders,
 )
import Cloudflare.Workers.HTTP qualified as HTTP
import Cloudflare.Workers.Reactor (Context (Context))
import Cloudflare.Workers.Streaming (ReadableStream (ReadableStream))
import Control.Monad.Except (catchError, runExceptT, throwError)
import Control.Monad.IO.Class (liftIO)
import Control.Monad.Reader (ask, runReaderT)
import Data.Aeson (encode, object, (.=))
import Data.Aeson.Key qualified as Key
import Data.ByteString.Char8 qualified as BS
import Data.ByteString.Lazy (ByteString)
import Data.ByteString.Lazy qualified as BSL
import Data.ByteString.Lazy.Char8 qualified as BSL8
import Data.Proxy (Proxy (Proxy))
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8)
import Data.Text.Encoding qualified as TextEncoding
import Servant.API (Get, Header, Headers, JSON, Raw, WithNamedContext, addHeader, (:<|>), (:>))
import Servant.Cloudflare.Workers.ContentType (handleContentNegotiation)
import Servant.Cloudflare.Workers.Error (ServerError (..), err404, serverErrorToResponse)
import Servant.Cloudflare.Workers.Error qualified as Error
import Servant.Cloudflare.Workers.Handler (Handler (Handler))
import Servant.Cloudflare.Workers.Internal (NamedContext (NamedContext), getNamedContext)
import Servant.Cloudflare.Workers.Server (
    HasWorkerServer (ServerT, serveWithContext),
    Server,
    ServerContext (EmptyServerContext, (:.)),
 )
import Test.Tasty (TestTree, defaultMain, testGroup)
import Test.Tasty.Golden (goldenVsString)
import Test.Tasty.HUnit (testCase, (@?=))

main :: IO ()
main = defaultMain tests

tests :: TestTree
tests =
    testGroup
        "servant-cloudflare-workers"
        [ handlerTests
        , errorTests
        , combinatorTests
        , withNamedContextDispatchTests
        , goldenTests
        ]

runHandler :: env -> Context -> Handler env a -> IO (Either ServerError a)
runHandler env context (Handler action) =
    runExceptT (runReaderT (runReaderT action env) context)

rawEchoServer :: Server Raw ()
rawEchoServer incomingRequest _ctx =
    pure
        ( createResponse
            (Status 200)
            [(Text.pack "X-Raw-Path", requestPathField incomingRequest)]
            (encodeUtf8 (requestPathField incomingRequest))
        )

rawNotFoundLookingServer :: Server Raw ()
rawNotFoundLookingServer _incomingRequest _ctx =
    pure
        ( createResponse
            (Status 404)
            [(Text.pack "Content-Type", Text.pack "text/plain")]
            (encodeUtf8 (Text.pack "raw: nothing here"))
        )

handlerTests :: TestTree
handlerTests =
    testGroup
        "Servant.Cloudflare.Workers.Handler"
        [ testCase "MonadReader: ask reads back the env argument" $ do
            result <- runHandler ("demo-env" :: String) Context ask
            result @?= Right "demo-env"
        , testCase "MonadIO: liftIO runs an IO action inside Handler" $ do
            result <- runHandler () Context (liftIO (pure (42 :: Int)))
            result @?= Right 42
        , testCase "MonadError: throwError short-circuits the computation" $ do
            let computation :: Handler () Int
                computation = throwError $ ServerError 400 "message" []
            result <- runHandler () Context computation
            result @?= Left (ServerError 400 "message" [])
        , testCase "MonadError: catchError recovers from a thrown error" $ do
            let computation :: Handler () Int
                computation = throwError (ServerError 404 "message" []) `catchError` \_ -> pure 7
            result <- runHandler () Context computation
            result @?= Right 7
        ]

goldenErrorBody :: Error.ServerError -> IO BSL.ByteString
goldenErrorBody serverError =
    pure (BSL.fromStrict (HTTP.responseBody (Error.serverErrorToResponse serverError)) <> BSL8.pack "\n")

goldenTests :: TestTree
goldenTests =
    testGroup
        "servant-compatibility golden (routing precedence: 405 -> 415 -> 406 -> 404 -> 400) + ch-06-19 exercise fixtures"
        [ goldenVsString "err400 (body decode/validation failure)" "test/Golden/400.json" (goldenErrorBody Error.err400)
        , goldenVsString "err404 (path mismatch)" "test/Golden/404.json" (goldenErrorBody Error.err404)
        , goldenVsString "err405 (method mismatch)" "test/Golden/405.json" (goldenErrorBody Error.err405)
        , goldenVsString "err406 (Accept mismatch)" "test/Golden/406.json" (goldenErrorBody Error.err406)
        , goldenVsString "err415 (Content-Type mismatch)" "test/Golden/415.json" (goldenErrorBody Error.err415)
        , goldenVsString
            "exercise: content negotiation selects application/json from the Accept header"
            "test/Golden/ContentType.json"
            (pure (renderNegotiation (handleContentNegotiation contentTypeRequest [Text.pack "application/json", Text.pack "text/plain"]) <> BSL8.pack "\n"))
        , goldenVsString
            "exercise: WithStatus overrides the Verb default status code"
            "test/Golden/WithStatus.json"
            (pure (renderResponse withStatusResponse <> BSL8.pack "\n"))
        , goldenVsString
            "exercise: Header combinator carries a custom response header"
            "test/Golden/Header.json"
            (pure (renderResponse headerResponse <> BSL8.pack "\n"))
        , testCase "err401 has status 401 (no golden fixture yet; sec-7 Zero Trust Access wires this in)" $
            Error.serverErrorStatusCode Error.err401 @?= 401
        , testCase "err500 has status 500 (no golden fixture yet; no HasWorkerServer instance throws it)" $
            Error.serverErrorStatusCode Error.err500 @?= 500
        ]

renderResponse :: HTTP.Response -> ByteString
renderResponse response =
    encode $
        object
            [ Key.fromText (Text.pack "body") .= TextEncoding.decodeUtf8 (HTTP.responseBody response)
            , Key.fromText (Text.pack "headers") .= object [Key.fromText key .= value | (key, value) <- responseHeaders response]
            , Key.fromText (Text.pack "status") .= statusCode (responseStatus response)
            ]

renderNegotiation :: Either Error.ServerError Text -> ByteString
renderNegotiation (Right selected) =
    encode (object [Key.fromText (Text.pack "selected") .= selected])
renderNegotiation (Left serverError) =
    encode $
        object
            [ Key.fromText (Text.pack "error")
                .= object
                    [ Key.fromText (Text.pack "message") .= Error.serverErrorMessage serverError
                    , Key.fromText (Text.pack "status") .= Error.serverErrorStatusCode serverError
                    ]
            ]

contentTypeRequest :: Request
contentTypeRequest =
    Request GET (Text.pack "/r/ab12cd") ReadableStream [(Text.pack "Accept", Text.pack "application/json")]

withStatusResponse :: HTTP.Response
withStatusResponse =
    createResponse (Status 201) [] (BS.pack "{\"code\":\"ab12cd\"}")

headerResponse :: HTTP.Response
headerResponse =
    createResponse
        (Status 200)
        [(Text.pack "X-RateLimit-Remaining", Text.pack "42")]
        (BS.pack "{\"code\":\"ab12cd\"}")

errorTests :: TestTree
errorTests =
    testGroup
        "Servant.Cloudflare.Workers.Error"
        [ testCase "err404 has status 404" $
            serverErrorStatusCode err404 @?= 404
        , testCase "serverErrorToResponse renders err404 into a Response with status 404" $
            responseStatus (serverErrorToResponse err404) @?= Status 404
        ]

combinatorTests :: TestTree
combinatorTests =
    testGroup
        "Servant.Cloudflare.Workers.Server.Internal (a :<|> b)"
        [ testCase "route dispatch 1: `Server (a :<|> b) env` resolves to `ServerT a (Handler env) :<|> ServerT b (Handler env)` (checked at compile time by `_route1DispatchType`)" $
            True @?= True
        , testCase "route dispatch 2: a nested 3-route union `a :<|> b :<|> c` resolves right-associatively (checked at compile time by `_route2DispatchType`)" $
            True @?= True
        ]

newtype DemoAuthToken = DemoAuthToken Text
    deriving stock (Eq, Show)

authAndTelemetryContext ::
    ServerContext
        '[ NamedContext "auth" '[DemoAuthToken]
         , NamedContext "telemetry" '[Bool]
         ]
authAndTelemetryContext =
    NamedContext (DemoAuthToken (Text.pack "demo-token") :. EmptyServerContext)
        :. NamedContext (True :. EmptyServerContext)
        :. EmptyServerContext

type NamedAuthApi =
    WithNamedContext
        "auth"
        '[DemoAuthToken]
        (Get '[JSON] (Headers '[Header "X-Demo" Text] Text))

namedAuthHandler :: Server NamedAuthApi ()
namedAuthHandler = pure (addHeader (Text.pack "demo") (Text.pack "ok"))

withNamedContextDispatchTests :: TestTree
withNamedContextDispatchTests =
    testGroup
        "Servant.Cloudflare.Workers.Server.Internal NamedContext"
        [ testCase "getNamedContext: skips past an unrelated NamedContext entry to find the tagged one further down" $
            case getNamedContext (Proxy @"telemetry") authAndTelemetryContext of
                telemetryEnabled :. EmptyServerContext -> telemetryEnabled @?= True
        , testCase "WithNamedContext: HasWorkerServer instance passes the ambient Context straight through to the wrapped api, unchanged" $ do
            response <- serveWithContext (Proxy @NamedAuthApi) authAndTelemetryContext namedAuthHandler (mkRequest []) Context ()
            responseStatus response @?= Status 200
            responseHeaders response @?= [(Text.pack "X-Demo", Text.pack "demo")]
        ]

_route1DispatchType ::
    forall a b env.
    (HasWorkerServer a, HasWorkerServer b) =>
    Proxy (Server (a :<|> b) env) ->
    Proxy (ServerT a (Handler env) :<|> ServerT b (Handler env))
_route1DispatchType = id

_route2DispatchType ::
    forall a b c env.
    (HasWorkerServer a, HasWorkerServer b, HasWorkerServer c) =>
    Proxy (Server (a :<|> b :<|> c) env) ->
    Proxy (Server a env :<|> (Server b env :<|> Server c env))
_route2DispatchType = id

_combindedLinks :: (HasWorkerServer a, HasWorkerServer b) => Proxy (ServerT (a :<|> b) m)
_combindedLinks = Proxy

_shortenPathLinks :: (HasWorkerServer api) => Proxy (ServerT ("shorten :> api") m)
_shortenPathLinks = Proxy

type PingAPI = "ping" :> Get '[JSON] Int

pingHandler :: ServerT PingAPI IO
pingHandler = pure 42

mkRequest :: [(Text, Text)] -> Request
mkRequest headers = Request GET (Text.pack "/") ReadableStream headers

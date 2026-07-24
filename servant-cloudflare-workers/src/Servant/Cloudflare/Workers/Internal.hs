{-# LANGUAGE FunctionalDependencies #-}

module Servant.Cloudflare.Workers.Internal (
    NamedContext (..),
    getNamedContext,
) where

import Cloudflare.Workers.HTTP (Request (requestHeaders), Response, Status (Status), createResponse)
import Cloudflare.Workers.Reactor (Context)
import Cloudflare.Workers.Streaming (ReadableStream (ReadableStream))
import Control.Monad.Except (runExceptT)
import Control.Monad.Reader (ReaderT (runReaderT))
import Data.ByteString (ByteString)
import Data.ByteString.Lazy qualified as Lazy
import Data.CaseInsensitive qualified as CaseInsentive
import Data.Kind (Type)
import Data.Maybe (listToMaybe)
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8)
import GHC.TypeLits (KnownNat, KnownSymbol, Symbol, natVal, symbolVal)
import Servant.API (
    Capture,
    Description,
    EmptyAPI (EmptyAPI),
    FromHttpApiData (parseQueryParam),
    GetHeaders (getHeaders),
    Header,
    Headers (getResponse),
    MimeRender (mimeRender),
    MimeUnrender,
    NoContent (NoContent),
    QueryFlag,
    QueryParam,
    QueryParams,
    Raw,
    ReqBody,
    Stream,
    Summary,
    Verb,
    WithNamedContext,
    WithStatus (WithStatus),
    (:<|>) (..),
    (:>),
 )
import Servant.API.ContentTypes (MimeRender)
import Servant.Cloudflare.Workers.Error (ServerError, err400, err404, serverErrorToResponse)
import Servant.Cloudflare.Workers.Handler (Handler (unHandler))
import Servant.Cloudflare.Workers.Server (HasWorkerServer (ServerT, serveWithContext), ServerContext (EmptyServerContext, (:.)))
import Web.HttpApiData (FromHttpApiData)

runHandlerToIO :: env -> Context -> Handler env a -> IO (Either ServerError a)
runHandlerToIO env context handler =
    runExceptT (runReaderT (runReaderT (unHandler handler) env) context)

instance (HasWorkerServer a, HasWorkerServer b) => HasWorkerServer (a :<|> b) where
    type ServerT (a :<|> b) m = ServerT a m :<|> ServerT b m
    serveWithContext = error "umimplemented"

instance (KnownSymbol path, HasWorkerServer api) => HasWorkerServer (path :> api) where
    type ServerT (path :> api) m = ServerT api m
    serveWithContext = error "unimplemented"

instance (KnownNat statusCode, MimeRender ct a) => HasWorkerServer (Verb method statusCode (ct ': cts) a) where
    type ServerT (Verb method statusCode (ct ': cts) a) m = m a
    serveWithContext = error "unimplemented"

instance (KnownSymbol symbol, FromHttpApiData a, HasWorkerServer api) => HasWorkerServer (Capture symbol a :> api) where
    type ServerT (Capture symbol a :> api) m = a -> ServerT api m
    serveWithContext = error "unimplemented"

instance (KnownSymbol symbol, FromHttpApiData a, HasWorkerServer api) => HasWorkerServer (QueryParam symbol a :> api) where
    type ServerT (QueryParam symbol a :> api) m = Maybe a -> ServerT api m
    serveWithContext = error "unimplemented"

instance (KnownSymbol symbol, FromHttpApiData a, HasWorkerServer api) => HasWorkerServer (QueryParams symbol a :> api) where
    type ServerT (QueryParams symbol a :> api) m = [a] -> ServerT api m
    serveWithContext = error "unimplemented"

instance (KnownSymbol symbol, HasWorkerServer api) => HasWorkerServer (QueryFlag symbol :> api) where
    type ServerT (QueryFlag symbol :> api) m = Bool -> ServerT api m
    serveWithContext = error "unimplemented"

instance (KnownSymbol symbol, FromHttpApiData a, HasWorkerServer api) => HasWorkerServer (Header symbol a :> api) where
    type ServerT (Header symbol a :> api) m = Maybe a -> ServerT api m

    serveWithContext Proxy serverContext subserver request workerContext env =
        case lookupCaseInsensitive headerName (requestHeaders request) of
            Nothing -> serveWithContext (Proxy @api) serverContext (subserver Nothing) request workerContext env
            Just rawValue ->
                case parseQueryParam rawValue of
                    Left _parseError -> pure (serverErrorToResponse err400)
                    Right parsedValue -> serveWithContext (Proxy @api) serverContext (subserver (Just parsedValue)) request workerContext env
      where
        headerName = Text.pack (symbolVal (Proxy @symbol))

        lookupCaseInsensitive :: Text -> [(Text, Text)] -> Maybe Text
        lookupCaseInsensitive name headers =
            listToMaybe [value | (key, value) <- headers, Text.toCaseFold key == Text.toCaseFold name]

instance
    {-# OVERLAPPING #-}
    (KnownNat statusCode, MimeRender ct v, GetHeaders (Headers headerList v)) =>
    HasWorkerServer (Verb method statusCode (ct ': cts) (Headers headerList v))
    where
    type ServerT (Verb method statusCode (ct ': cts) (Headers headerList v)) m = m (Headers headerList v)

    serveWithContext Proxy _serverContext handler _request workerContext env = do
        outcome <- runHandlerToIO env workerContext handler
        pure $ case outcome of
            Left serverError -> serverErrorToResponse serverError
            Right headersValue ->
                createResponse
                    (Status (fromInteger (natVal (Proxy @statusCode))))
                    (renderExtraHeaders (getHeaders headersValue))
                    (Lazy.toStrict (mimeRender (Proxy @ct) (getResponse headersValue)))
      where
        renderExtraHeaders :: [(CaseInsentive.CI ByteString, ByteString)] -> [(Text, Text)]
        renderExtraHeaders raw =
            [(decodeUtf8 (CaseInsentive.original name), decodeUtf8 value) | (name, value) <- raw]

instance (MimeUnrender ct a, HasWorkerServer api) => HasWorkerServer (ReqBody (ct ': cts) a :> api) where
    type ServerT (ReqBody (ct ': cts) a :> api) m = a -> ServerT api m
    serveWithContext = error "unimplemented"

data EmptyServer = EmptyServer

instance HasWorkerServer EmptyAPI where
    type ServerT EmptyAPI m = EmptyServer
    serveWithContext Proxy _serverContext EmptyServer _request _workerContext _env =
        pure (serverErrorToResponse err404)

instance
    {-# OVERLAPPING #-}
    (KnownNat statusCode) =>
    HasWorkerServer (Verb method statusCode (ct ': cts) NoContent)
    where
    type ServerT (Verb method statusCode (ct ': cts) NoContent) m = m NoContent

    serveWithContext Proxy _serverContext handler _request workerContext env = do
        outcome <- runHandlerToIO env workerContext handler
        pure $ case outcome of
            Left serverError -> serverErrorToResponse serverError
            Right NoContent ->
                createResponse (Status (fromInteger (natVal (Proxy @statusCode)))) [] mempty

instance
    {-# OVERLAPPING #-}
    (KnownNat overrideStatusCode, MimeRender ct a) =>
    HasWorkerServer (Verb method statusCode (ct ': cts) (WithStatus overrideStatusCode a))
    where
    type ServerT (Verb method statusCode (ct ': cts) (WithStatus overrideStatusCode a)) m = m (WithStatus overrideStatusCode a)

    serveWithContext Proxy _serverContext handler _request workerContext env = do
        outcome <- runHandlerToIO env workerContext handler
        pure $ case outcome of
            Left serverError -> serverErrorToResponse serverError
            Right (WithStatus value) ->
                createResponse
                    (Status (fromInteger (natVal (Proxy @overrideStatusCode))))
                    []
                    (Lazy.toStrict (mimeRender (Proxy @ct) value))

instance (HasWorkerServer api) => HasWorkerServer (Description description :> api) where
    type ServerT (Description description :> api) m = ServerT api m

    serveWithContext Proxy serverContext subserver request workerContext env =
        serveWithContext (Proxy @api) serverContext subserver request workerContext env

instance (HasWorkerServer api) => HasWorkerServer (Summary summary :> api) where
    type ServerT (Summary summary :> api) m = ServerT api m

    serveWithContext Proxy serverContext subserver request workerContext env =
        serveWithContext (Proxy @api) serverContext subserver request workerContext env

instance HasWorkerServer Raw where
    type ServerT Raw m = Request -> Context -> m Response

    serveWithContext Proxy _serverContext rawHandler request workerContext env = do
        outcome <- runHandlerToIO env workerContext (rawHandler request workerContext)
        pure $ case outcome of
            Left serverError -> serverErrorToResponse serverError
            Right response -> response

instance (KnownNat statusCode) => HasWorkerServer (Stream method statusCode framing contentType ReadableStream) where
    type ServerT (Stream method statusCode framing contentType ReadableStream) m = m ReadableStream
    serveWithContext = error "unimplemented"

newtype NamedContext (name :: Symbol) (subContext :: [Type]) = NamedContext (ServerContext subContext)

class
    HasNamedContextEntry
        (mainContext :: [Type])
        (name :: Symbol)
        (subContext :: [Type])
        | mainContext name -> subContext
    where
    getNamedContext :: Proxy name -> ServerContext mainContext -> ServerContext subContext

instance {-# OVERLAPPING #-} HasNamedContextEntry (NamedContext name subContext ': rest) name subContext where
    getNamedContext Proxy (NamedContext innerContext :. _) = innerContext

instance {-# OVERLAPPING #-} (HasNamedContextEntry rest name subContext) => HasNamedContextEntry (entry ': rest) name subContext where
    getNamedContext proxy (_ :. rest) = getNamedContext proxy rest

instance (HasWorkerServer api) => HasWorkerServer (WithNamedContext name subContext api) where
    type ServerT (WithNamedContext name subContext api) m = ServerT api m

    serveWithContext Proxy context subserver request ctx env =
        serveWithContext (Proxy @api) context subserver request ctx env

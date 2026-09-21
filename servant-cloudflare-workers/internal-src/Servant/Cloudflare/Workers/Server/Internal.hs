{-# LANGUAGE QuantifiedConstraints #-}
{-# LANGUAGE ScopedTypeVariables #-}
{-# LANGUAGE TypeApplications #-}
{-# OPTIONS_GHC -Wno-orphans #-}

{- |
Workers server interpreter adapted in part from @servant-server-0.20.3.0@
@Servant.Server.Internal@ and @Servant.Server.UVerb@.

Copyright (c) 2014-2016, Zalora South East Asia Pte Ltd,
2016-2018 Servant Contributors. Distributed under BSD-3-Clause.
The port replaces WAI responses and routing with Cloudflare Workers-native
types and keeps the package independent of @servant-server@.
-}
module Servant.Cloudflare.Workers.Server.Internal (
    EmptyServer (..),
    runHandlerAction,
    Dict (..),
    AsWorkerT,
    GWorkerServerConstraints,
    GWorkerServer (..),
) where

import Cloudflare.Workers.HTTP (
    Method,
    Request (requestHeaders),
    Response,
    ResponseBody (ResponseBodyBytes, ResponseBodyLazyBytes, ResponseBodyStream),
    Status (..),
    createResponse,
    defaultRequestBodyByteLimit,
    methodToText,
    requestBodyReader,
    requestMethod,
    requestURL,
 )
import Cloudflare.Workers.Headers (headerLookup, headersFromList)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Cloudflare.Workers.Streaming (ReadableStream, readableStreamCancel)
import Cloudflare.Workers.URL (percentDecode, urlQueryStringVerbatim)
import Control.Monad (when)
import Control.Monad.Except (runExceptT)
import Control.Monad.IO.Class (MonadIO (liftIO))
import Control.Monad.Reader (runReaderT)
import Data.ByteString qualified as ByteString
import Data.ByteString.Lazy qualified as LazyByteString
import Data.CaseInsensitive qualified as CI
import Data.Either (partitionEithers)
import Data.Kind (Constraint, Type)
import Data.Maybe qualified as Maybe
import Data.Proxy (Proxy (Proxy))
import Data.SOP.Constraint (All)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import Data.Text.Encoding.Error (lenientDecode)
import Data.Typeable (Typeable, typeRep)
import GHC.TypeLits (KnownNat, KnownSymbol, natVal, symbolVal)
import Network.HTTP.Media qualified as HTTPMedia
import Network.HTTP.Types.Status qualified as HTTPStatus
import Servant.API (
    Capture,
    CaptureAll,
    EmptyAPI,
    FromHttpApiData (parseHeader, parseQueryParam, parseUrlPiece),
    GenericMode,
    Header,
    NamedRoutes,
    NoContent,
    NoContentVerb,
    NoFraming,
    QueryFlag,
    QueryParam,
    QueryParams,
    Raw,
    ReflectMethod (reflectMethod),
    ReqBody,
    Stream,
    Verb,
    WithNamedContext,
    (:<|>) (..),
    (:>),
 )
import Servant.API.ContentTypes (
    Accept (contentType),
    AcceptHeader (..),
    AllCTRender (handleAcceptH),
    AllCTUnrender (canHandleCTypeH),
    AllMime,
 )
import Servant.API.Generic (GServantProduct, Generic (Rep), GenericMode (type (:-)), ToServant, ToServantApi, toServant)
import Servant.API.ResponseHeaders (GetHeaders (getHeaders), Headers, getResponse)
import Servant.API.TypeErrors (ErrorIfNoGeneric)
import Servant.API.UVerb (HasStatus, HasStatuses (Statuses), UVerb, Union, Unique, WithStatus (WithStatus), foldMapUnion, statusOf)
import Servant.Cloudflare.Workers.ContentType (acceptCheck, getAcceptHeader, getContentTypeHeader)
import Servant.Cloudflare.Workers.Error (ServerError (serverErrorHeaders), err400, err405, err406, err413, err415, serverErrorToResponse, withDetail)
import Servant.Cloudflare.Workers.Handler (Handler (unHandler))
import Servant.Cloudflare.Workers.Server.Internal.Context (
    Context,
    HasContextEntry,
    NamedContext,
    descendIntoNamedContext,
 )
import Servant.Cloudflare.Workers.Server.Internal.Delayed (
    Delayed,
    addBodyCheck,
    addCapture,
    addHeaderCheck,
    addMethodCheck,
    addParameterCheck,
    passToServer,
    runDelayed,
 )
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (DelayedIO, delayedFail, delayedFailFatal, withRequest)
import Servant.Cloudflare.Workers.Server.Internal.HasWorkerServer (HasWorkerServer (ServerT, route))
import Servant.Cloudflare.Workers.Server.Internal.RouteResult (RouteResult (Fail, FailFatal, Route))
import Servant.Cloudflare.Workers.Server.Internal.Router (
    CaptureHint (CaptureHint),
    Router,
    Router' (CaptureAllRouter, CaptureRouter, RawRouter, StaticRouter),
    choice,
    leafRouter,
    pathRouter,
 )
import Web.HttpApiData (parseUrlPieces)

runHandlerAction ::
    WorkersExecutionContext ->
    bindingEnv ->
    Delayed captureEnv (Handler bindingEnv a) ->
    captureEnv ->
    Request ->
    (a -> IO (RouteResult Response)) ->
    IO (RouteResult Response)
runHandlerAction cloudflareContext bindingEnv delayed captureEnv request toResponse = do
    delayedResult <- runDelayed delayed captureEnv request
    case delayedResult of
        Fail err -> pure (Fail err)
        FailFatal err -> pure (FailFatal err)
        Route handlerAction -> do
            handlerResult <- runExceptT (runReaderT (runReaderT (unHandler handlerAction) bindingEnv) cloudflareContext)
            case handlerResult of
                Left err -> pure (Route (serverErrorToResponse request err))
                Right value -> toResponse value

instance (HasWorkerServer a context, HasWorkerServer b context) => HasWorkerServer (a :<|> b) context where
    type ServerT (a :<|> b) m = ServerT a m :<|> ServerT b m

    route ::
        forall capEnv bindingEnv.
        Proxy (a :<|> b) ->
        Context context ->
        Delayed capEnv (ServerT (a :<|> b) (Handler bindingEnv)) ->
        Router capEnv bindingEnv
    route Proxy context delayedServer =
        choice
            (route @a @context @capEnv @bindingEnv (Proxy :: Proxy a) context (fmap (\(leftServer :<|> _) -> leftServer) delayedServer))
            (route @b @context @capEnv @bindingEnv (Proxy :: Proxy b) context (fmap (\(_ :<|> rightServer) -> rightServer) delayedServer))

methodToBytes :: Method -> ByteString.ByteString
methodToBytes = TextEncoding.encodeUtf8 . methodToText

acceptedMethodNames :: ByteString.ByteString -> [Text.Text]
acceptedMethodNames reflectedMethod
    | reflectedMethod == "GET" = ["GET", "HEAD"]
    | otherwise = [TextEncoding.decodeUtf8 reflectedMethod]

allowdMethod :: ByteString.ByteString -> Request -> Bool
allowdMethod reflectedMethod request =
    TextEncoding.decodeUtf8 (methodToBytes (requestMethod request))
        `elem` acceptedMethodNames reflectedMethod

allowedMethodHead :: ByteString.ByteString -> Request -> Bool
allowedMethodHead reflectedMethod request =
    reflectedMethod == "GET" && methodToBytes (requestMethod request) == "HEAD"

methodCheck :: ByteString.ByteString -> Request -> DelayedIO ()
methodCheck reflectedMethod request
    | allowdMethod reflectedMethod request = pure ()
    | otherwise =
        delayedFail
            err405{serverErrorHeaders = [("Allow", Text.intercalate ", " (acceptedMethodNames reflectedMethod))]}

-- Response wrappers describe HTTP metadata rather than a serializable body.
-- Peel them before content negotiation, preserving every supplied header.
class (AllMime ctypes) => WorkerRender ctypes a where
    renderWorker :: Proxy ctypes -> AcceptHeader -> a -> Maybe ([(Text.Text, Text.Text)], LazyByteString.ByteString)

instance {-# OVERLAPPABLE #-} (AllMime ctypes, AllCTRender ctypes a) => WorkerRender ctypes a where
    renderWorker proxy accept value = do
        (contentTypeBytes, bodyBytes) <- handleAcceptH proxy accept value
        pure ([contentTypeHeader contentTypeBytes], bodyBytes)

instance {-# OVERLAPPING #-} (AllMime ctypes) => WorkerRender ctypes NoContent where
    renderWorker _proxy _accept _value = Just ([], LazyByteString.empty)

instance {-# OVERLAPPING #-} (WorkerRender ctypes a, GetHeaders (Headers hs a)) => WorkerRender ctypes (Headers hs a) where
    renderWorker proxy accept value = do
        (headers, bodyBytes) <- renderWorker proxy accept (getResponse value)
        pure (workerResponseHeaders value <> headers, bodyBytes)

instance {-# OVERLAPPING #-} (WorkerRender ctypes a) => WorkerRender ctypes (WithStatus status a) where
    renderWorker proxy accept (WithStatus value) = renderWorker proxy accept value

class (AllMime ctypes) => WorkerResponseRender ctypes a where
    renderWorkerResponse :: Proxy ctypes -> AcceptHeader -> a -> Maybe (LazyByteString.ByteString, [(Text.Text, Text.Text)], LazyByteString.ByteString)

instance {-# OVERLAPPABLE #-} (AllMime ctypes, AllCTRender ctypes a) => WorkerResponseRender ctypes a where
    renderWorkerResponse proxy accept value = do
        (contentTypeBytes, bodyBytes) <- handleAcceptH proxy accept value
        pure (contentTypeBytes, [], bodyBytes)

instance {-# OVERLAPPING #-} (WorkerResponseRender ctypes a, GetHeaders (Headers hs a)) => WorkerResponseRender ctypes (Headers hs a) where
    renderWorkerResponse proxy accept value = do
        (contentTypeBytes, headers, bodyBytes) <- renderWorkerResponse proxy accept (getResponse value)
        pure (contentTypeBytes, workerResponseHeaders value <> headers, bodyBytes)

instance {-# OVERLAPPING #-} (WorkerResponseRender ctypes a) => WorkerResponseRender ctypes (WithStatus status a) where
    renderWorkerResponse proxy accept (WithStatus value) = renderWorkerResponse proxy accept value

class (WorkerResponseRender ctypes a, HasStatus a) => WorkerResponse ctypes a
instance (WorkerResponseRender ctypes a, HasStatus a) => WorkerResponse ctypes a

contentTypeHeader :: LazyByteString.ByteString -> (Text.Text, Text.Text)
contentTypeHeader contentTypeBytes =
    ("Content-Type", TextEncoding.decodeUtf8 (LazyByteString.toStrict contentTypeBytes))

workerResponseHeaders :: (GetHeaders a) => a -> [(Text.Text, Text.Text)]
workerResponseHeaders =
    map
        ( \(name, value) ->
            (TextEncoding.decodeUtf8With lenientDecode (CI.original name), TextEncoding.decodeUtf8With lenientDecode value)
        )
        . getHeaders

class WorkerStream a where
    workerStream :: a -> (ReadableStream, [(Text.Text, Text.Text)])

instance WorkerStream ReadableStream where
    workerStream stream = (stream, [])

instance (WorkerStream a, GetHeaders (Headers hs a)) => WorkerStream (Headers hs a) where
    workerStream value =
        let (stream, headers) = workerStream (getResponse value)
         in (stream, headers <> workerResponseHeaders value)

renderVerbResult ::
    (WorkerRender ctypes a) =>
    Proxy ctypes ->
    AcceptHeader ->
    ByteString.ByteString ->
    Status ->
    Request ->
    a ->
    RouteResult Response
renderVerbResult ctypesProxy acceptHeader reflectedMethod status request value =
    case renderWorker ctypesProxy acceptHeader value of
        Nothing -> FailFatal err406 -- should not happen (acceptCheck already checked); fatal if it does
        Just (responseHeaders, bodyBytes) ->
            let responseBody
                    | allowedMethodHead reflectedMethod request = LazyByteString.empty
                    | otherwise = bodyBytes
             in Route
                    ( createResponse
                        status
                        (headersFromList responseHeaders)
                        (ResponseBodyLazyBytes responseBody)
                    )

methodRouter ::
    (WorkerRender ctypes a) =>
    ByteString.ByteString ->
    Proxy ctypes ->
    Status ->
    Delayed captureEnv (Handler bindingEnv a) ->
    Router captureEnv bindingEnv
methodRouter reflectedMethod ctypesProxy status action = leafRouter dispatch
  where
    dispatch captureEnv _residualSegments request cloudflareContext bindingEnv =
        let acceptHeader = getAcceptHeader request
         in runHandlerAction
                cloudflareContext
                bindingEnv
                ( action
                    `addMethodCheck` methodCheck reflectedMethod request
                    `addMethodCheck` acceptCheck ctypesProxy acceptHeader
                )
                captureEnv
                request
                (pure . renderVerbResult ctypesProxy acceptHeader reflectedMethod status request)

instance
    (KnownNat statusCode, WorkerRender (ct ': cts) a, ReflectMethod method) =>
    HasWorkerServer (Verb method statusCode (ct ': cts) a) context
    where
    type ServerT (Verb method statusCode (ct ': cts) a) m = m a

    route Proxy _context =
        methodRouter (reflectMethod (Proxy :: Proxy method)) (Proxy :: Proxy (ct ': cts)) status
      where
        status = Status (fromInteger (natVal (Proxy :: Proxy statusCode)))

instance
    (ReflectMethod method, AllMime ctypes, All (WorkerResponse ctypes) as, Unique (Statuses as)) =>
    HasWorkerServer (UVerb method ctypes as) context
    where
    type ServerT (UVerb method ctypes as) m = m (Union as)
    route Proxy _context action = leafRouter dispatch
      where
        reflectedMethod = reflectMethod (Proxy :: Proxy method)
        ctypesProxy = Proxy :: Proxy ctypes
        dispatch captureEnv _residualSegments request cloudflareContext bindingEnv =
            let acceptHeader = getAcceptHeader request
             in runHandlerAction
                    cloudflareContext
                    bindingEnv
                    ( action
                        `addMethodCheck` methodCheck reflectedMethod request
                        `addMethodCheck` acceptCheck ctypesProxy acceptHeader
                    )
                    captureEnv
                    request
                    (pure . foldMapUnion (Proxy :: Proxy (WorkerResponse ctypes)) (renderSelected acceptHeader request))
        renderSelected :: forall a. (WorkerResponse ctypes a) => AcceptHeader -> Request -> a -> RouteResult Response
        renderSelected acceptHeader request value =
            case renderWorkerResponse ctypesProxy acceptHeader value of
                Nothing -> FailFatal err406 -- should not happen (acceptCheck already checked); fatal if it does
                Just (contentTypeBytes, responseHeaders, bodyBytes) ->
                    let responseBody
                            | allowedMethodHead reflectedMethod request = LazyByteString.empty
                            | otherwise = bodyBytes
                     in Route
                            ( createResponse
                                (Status (HTTPStatus.statusCode (statusOf (Proxy :: Proxy a))))
                                (headersFromList (contentTypeHeader contentTypeBytes : responseHeaders))
                                (ResponseBodyLazyBytes responseBody)
                            )

-- Native Workers streams pass through unchanged; NoFraming avoids buffering or
-- pretending an arbitrary framing encoder can operate on an opaque JS stream.
instance
    (KnownNat statusCode, Accept ct, ReflectMethod method, WorkerStream a) =>
    HasWorkerServer (Stream method statusCode NoFraming ct a) context
    where
    type ServerT (Stream method statusCode NoFraming ct a) m = m a
    route Proxy _context action = leafRouter $ \captureEnv _ request cloudflareContext bindingEnv ->
        runHandlerAction
            cloudflareContext
            bindingEnv
            ( action
                `addMethodCheck` methodCheck reflectedMethod request
                `addMethodCheck` acceptCheck (Proxy :: Proxy '[ct]) (getAcceptHeader request)
            )
            captureEnv
            request
            $ \value -> do
                let (stream, extraHeaders) = workerStream value
                when (allowedMethodHead reflectedMethod request) $ readableStreamCancel stream
                pure
                    ( Route
                        ( createResponse
                            status
                            (headersFromList ([("Content-Type", TextEncoding.decodeUtf8 (HTTPMedia.renderHeader (contentType (Proxy :: Proxy ct))))] <> extraHeaders))
                            (if allowedMethodHead reflectedMethod request then ResponseBodyBytes ByteString.empty else ResponseBodyStream stream)
                        )
                    )
      where
        reflectedMethod = reflectMethod (Proxy :: Proxy method)
        status = Status (fromInteger (natVal (Proxy :: Proxy statusCode)))

noContentRouter ::
    ByteString.ByteString ->
    Status ->
    Delayed captureEnv (Handler bindingEnv a) ->
    Router captureEnv bindingEnv
noContentRouter reflectedMethod status action = leafRouter dispatch
  where
    dispatch captureEnv _residualSegments request cloudflareContext bindingEnv =
        runHandlerAction
            cloudflareContext
            bindingEnv
            (action `addMethodCheck` methodCheck reflectedMethod request)
            captureEnv
            request
            (\_value -> pure (Route (createResponse status (headersFromList []) (ResponseBodyBytes ByteString.empty))))

instance (ReflectMethod method) => HasWorkerServer (NoContentVerb method) context where
    type ServerT (NoContentVerb method) m = m NoContent
    route Proxy _context =
        noContentRouter (reflectMethod (Proxy :: Proxy method)) (Status 204)

data EmptyServer = EmptyServer

instance HasWorkerServer EmptyAPI context where
    type ServerT EmptyAPI m = EmptyServer
    route Proxy _context _action = StaticRouter mempty mempty

instance (HasWorkerServer api context) => HasWorkerServer (EmptyAPI :> api) context where
    type ServerT (EmptyAPI :> api) m = ServerT api m

    route ::
        forall captureEnv bindingEnv.
        Proxy (EmptyAPI :> api) ->
        Context context ->
        Delayed captureEnv (ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy = route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api)

instance (KnownSymbol path, HasWorkerServer api context) => HasWorkerServer (path :> api) context where
    type ServerT (path :> api) m = ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (path :> api) ->
        Context context ->
        Delayed captureEnv (ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        pathRouter
            (Text.pack (symbolVal (Proxy :: Proxy path)))
            (route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context delayedServer)

instance
    (KnownSymbol symbol, FromHttpApiData a, Typeable a, HasWorkerServer api context) =>
    HasWorkerServer (Capture symbol a :> api) context
    where
    type ServerT (Capture symbol a :> api) m = a -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (Capture symbol a :> api) ->
        Context context ->
        Delayed captureEnv (a -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        CaptureRouter
            [hint]
            (route @api @context @(Text.Text, captureEnv) @bindingEnv (Proxy :: Proxy api) context (addCapture delayedServer parseCapturedSegment))
      where
        hint = CaptureHint (Text.pack (symbolVal (Proxy :: Proxy symbol))) (typeRep (Proxy :: Proxy a))

        parseCapturedSegment :: Text.Text -> DelayedIO a
        parseCapturedSegment rawSegment = case parseUrlPiece rawSegment of
            Left parseError -> delayedFail (withDetail parseError err400)
            Right value -> pure value

instance
    (KnownSymbol symbol, FromHttpApiData a, Typeable a, HasWorkerServer api context) =>
    HasWorkerServer (CaptureAll symbol a :> api) context
    where
    type ServerT (CaptureAll symbol a :> api) m = [a] -> ServerT api m

    route ::
        forall captureEnv bindingEnv.
        Proxy (CaptureAll symbol a :> api) ->
        Context context ->
        Delayed captureEnv ([a] -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        CaptureAllRouter
            [hint]
            (route @api @context @([Text.Text], captureEnv) @bindingEnv (Proxy :: Proxy api) context (addCapture delayedServer parseCapturedSegments))
      where
        hint = CaptureHint (Text.pack (symbolVal (Proxy :: Proxy symbol))) (typeRep (Proxy :: Proxy [a]))

        parseCapturedSegments :: [Text.Text] -> DelayedIO [a]
        parseCapturedSegments rawSegments = case parseUrlPieces rawSegments of
            Left parseError -> delayedFail (withDetail parseError err400)
            Right values -> pure values

instance HasWorkerServer Raw context where
    type ServerT Raw m = [Text.Text] -> Request -> WorkersExecutionContext -> IO Response
    route Proxy _context rawServerDelayed =
        RawRouter dispatch
      where
        dispatch captureEnv residualSegments request cloudflareContext _bindingEnv = do
            delayedResult <- runDelayed rawServerDelayed captureEnv request
            case delayedResult of
                Fail err -> pure (Fail err)
                FailFatal err -> pure (FailFatal err)
                Route rawHandler -> Route <$> rawHandler residualSegments request cloudflareContext

parseQueryText :: Text.Text -> [(Text.Text, Maybe Text.Text)]
parseQueryText rawQueryString
    | Text.null rawQueryString = []
    | otherwise = case Text.break isQueryStringSeparator rawQueryString of
        (rawPair, rest)
            | Text.null rest -> [parseQueryPair rawPair]
            | otherwise -> parseQueryPair rawPair : parseQueryText (Text.drop 1 rest)
  where
    isQueryStringSeparator :: Char -> Bool
    isQueryStringSeparator character = character == '&' || character == ';'

    parseQueryPair :: Text.Text -> (Text.Text, Maybe Text.Text)
    parseQueryPair rawPair =
        let (rawName, rawValueWithLeadingMark) = Text.break (== '=') rawPair
         in ( decodeQueryComponent rawName
            , if Text.null rawValueWithLeadingMark
                then Nothing
                else Just (decodeQueryComponent (Text.drop 1 rawValueWithLeadingMark))
            )

decodeQueryComponent :: Text.Text -> Text.Text
decodeQueryComponent = percentDecode . Text.replace "+" " "

queryTextFromRequest :: Request -> [(Text.Text, Maybe Text.Text)]
queryTextFromRequest = parseQueryText . urlQueryStringVerbatim . requestURL

instance
    (KnownSymbol symbol, FromHttpApiData a, HasWorkerServer api context) =>
    HasWorkerServer (QueryParam symbol a :> api) context
    where
    type ServerT (QueryParam symbol a :> api) m = Maybe a -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (QueryParam symbol a :> api) ->
        Context context ->
        Delayed captureEnv (Maybe a -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (addParameterCheck delayedServer (withRequest parseQueryParamValue))
      where
        paramName = Text.pack (symbolVal (Proxy :: Proxy symbol))

        parseQueryParamValue :: Request -> DelayedIO (Maybe a)
        parseQueryParamValue request = case lookup paramName (queryTextFromRequest request) of
            Nothing -> pure Nothing
            Just Nothing -> pure Nothing
            Just (Just rawValue) -> case parseQueryParam rawValue of
                Left parseError ->
                    delayedFailFatal (withDetail ("Error parsing query parameter " <> paramName <> " failed: " <> parseError) err400)
                Right value -> pure (Just value)

instance
    (KnownSymbol symbol, FromHttpApiData a, HasWorkerServer api context) =>
    HasWorkerServer (QueryParams symbol a :> api) context
    where
    type ServerT (QueryParams symbol a :> api) m = [a] -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (QueryParams symbol a :> api) ->
        Context context ->
        Delayed captureEnv ([a] -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (addParameterCheck delayedServer (withRequest parseQueryParamValues))
      where
        paramName = Text.pack (symbolVal (Proxy :: Proxy symbol))

        lookslikeParam :: Text.Text -> Bool
        lookslikeParam name = name == paramName || name == paramName <> "[]"

        occurrenceValue :: (Text.Text, Maybe Text.Text) -> Maybe Text.Text
        occurrenceValue (name, value)
            | lookslikeParam name = value
            | otherwise = Nothing

        parseQueryParamValues :: Request -> DelayedIO [a]
        parseQueryParamValues request =
            case partitionEithers (map parseQueryParam (Maybe.mapMaybe occurrenceValue (queryTextFromRequest request))) of
                ([], values) -> pure values
                (parseErrors, _) ->
                    delayedFailFatal
                        (withDetail ("Error parsing query parameter(s) " <> paramName <> " failed: " <> Text.intercalate ", " parseErrors) err400)

instance
    (KnownSymbol symbol, HasWorkerServer api context) =>
    HasWorkerServer (QueryFlag symbol :> api) context
    where
    type ServerT (QueryFlag symbol :> api) m = Bool -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (QueryFlag symbol :> api) ->
        Context context ->
        Delayed captureEnv (Bool -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (passToServer delayedServer isFlagPresent)
      where
        paramName = Text.pack (symbolVal (Proxy :: Proxy symbol))

        isFlagPresent :: Request -> Bool
        isFlagPresent request = case lookup paramName (queryTextFromRequest request) of
            Nothing -> False
            Just Nothing -> True
            Just (Just rawValue) -> rawValue == "true" || rawValue == "1" || rawValue == ""

instance
    (KnownSymbol symbol, FromHttpApiData a, HasWorkerServer api context) =>
    HasWorkerServer (Header symbol a :> api) context
    where
    type ServerT (Header symbol a :> api) m = Maybe a -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (Header symbol a :> api) ->
        Context context ->
        Delayed captureEnv (Maybe a -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (addHeaderCheck delayedServer (withRequest parseHeaderValue))
      where
        headerName = Text.pack (symbolVal (Proxy :: Proxy symbol))

        parseHeaderValue :: Request -> DelayedIO (Maybe a)
        parseHeaderValue request =
            case headerLookup headerName (requestHeaders request) of
                Nothing -> pure Nothing
                Just rawValue -> case parseHeader (TextEncoding.encodeUtf8 rawValue) of
                    Left parseError ->
                        delayedFailFatal (withDetail ("Error parsing header " <> headerName <> " failed: " <> parseError) err400)
                    Right value -> pure (Just value)

instance
    (HasContextEntry context (NamedContext name subContext), HasWorkerServer subAPI subContext) =>
    HasWorkerServer (WithNamedContext name subContext subAPI) context
    where
    type ServerT (WithNamedContext name subContext subAPI) m = ServerT subAPI m
    route ::
        forall captureEnv bindingEnv.
        Proxy (WithNamedContext name subContext subAPI) ->
        Context context ->
        Delayed captureEnv (ServerT subAPI (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context =
        route @subAPI @subContext @captureEnv @bindingEnv (Proxy :: Proxy subAPI) (descendIntoNamedContext (Proxy :: Proxy name) context)

instance
    (AllCTUnrender (ct ': cts) a, HasWorkerServer api context) =>
    HasWorkerServer (ReqBody (ct ': cts) a :> api) context
    where
    type ServerT (ReqBody (ct ': cts) a :> api) m = a -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (ReqBody (ct ': cts) a :> api) ->
        Context context ->
        Delayed captureEnv (a -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (addBodyCheck delayedServer contentTypeCheck bodyCheck)
      where
        contentTypeCheck :: DelayedIO (LazyByteString.ByteString -> Either String a)
        contentTypeCheck = withRequest $ \request ->
            case canHandleCTypeH (Proxy :: Proxy (ct ': cts)) (getContentTypeHeader request) of
                Nothing -> delayedFail err415
                Just decodeBody -> pure decodeBody

        readBodyBytes request = case requestBodyReader request of
            Nothing -> pure (Right LazyByteString.empty)
            Just reader -> reader defaultRequestBodyByteLimit

        bodyCheck :: (LazyByteString.ByteString -> Either String a) -> DelayedIO a
        bodyCheck decodeBody = withRequest $ \request -> do
            readResult <- liftIO (readBodyBytes request)
            case readResult of
                Left _bodyLimitExceeded -> delayedFailFatal err413
                Right bodyBytes -> case decodeBody bodyBytes of
                    Left decodeError -> delayedFailFatal (withDetail (Text.pack decodeError) err400)
                    Right value -> pure value

data Dict (c :: Constraint) where
    Dict :: (c) => Dict c

data AsWorkerT (m :: Type -> Type)

instance GenericMode (AsWorkerT m) where
    type AsWorkerT m :- api = ServerT api m

type GWorkerServerConstraints api m =
    ( ToServant api (AsWorkerT m) ~ ServerT (ToServantApi api) m
    , GServantProduct (Rep (api (AsWorkerT m)))
    )

class GWorkerServer (api :: Type -> Type) (m :: Type -> Type) where
    gWorkerServerProof :: Proxy api -> Proxy m -> Dict (GWorkerServerConstraints api m)

instance
    ( ToServant api (AsWorkerT m) ~ ServerT (ToServantApi api) m
    , GServantProduct (Rep (api (AsWorkerT m)))
    ) =>
    GWorkerServer api m
    where
    gWorkerServerProof Proxy Proxy = Dict

instance
    ( HasWorkerServer (ToServantApi api) context
    , forall m. Generic (api (AsWorkerT m))
    , forall m. GWorkerServer api m
    , ErrorIfNoGeneric api
    ) =>
    HasWorkerServer (NamedRoutes api) context
    where
    type ServerT (NamedRoutes api) m = api (AsWorkerT m)

    route ::
        forall captureEnv bindingEnv.
        Proxy (NamedRoutes api) ->
        Context context ->
        Delayed captureEnv (ServerT (NamedRoutes api) (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        case gWorkerServerProof (Proxy :: Proxy api) (Proxy :: Proxy (Handler bindingEnv)) of
            Dict ->
                route @(ToServantApi api) @context @captureEnv @bindingEnv
                    (Proxy :: Proxy (ToServantApi api))
                    context
                    (fmap toServant delayedServer)

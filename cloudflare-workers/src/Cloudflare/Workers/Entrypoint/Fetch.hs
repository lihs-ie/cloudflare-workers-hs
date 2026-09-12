module Cloudflare.Workers.Entrypoint.Fetch (
    FetchHandler,
    createFetchHandler,
) where

import Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.HTTP (Request (..), Response, ResponseBody (ResponseBodyBytes), Status (Status), createResponse, methodFromText)
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv, BuildDOSEnv)
import Cloudflare.Workers.Internal.FFI.Headers (headersFromJSVal)
import Cloudflare.Workers.Internal.FFI.Request (requestBodyJSVal, requestDataCenterText, requestHeadersJSVal, requestMethodText)
import Cloudflare.Workers.Internal.FFI.Response (responsetoJSVal)
import Cloudflare.Workers.Internal.FFI.URL (requestURLText)
import Cloudflare.Workers.Observability (tailLog)
import Cloudflare.Workers.Reactor (WorkersExecutionContext (WorkersExecutionContext))
import Cloudflare.Workers.Streaming (readableStreamFromJSVal, readableStreamToLazyByteString)
import Cloudflare.Workers.URL (parseURL)
import Control.Exception (Exception (displayException), SomeException, try)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

type FetchHandler env = Request -> env -> WorkersExecutionContext -> IO Response

createFetchHandler ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    FetchHandler (BindingEnv kvs dos bindings) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO JSVal
createFetchHandler handler requestJSVal envJSVal contextJSVal =
    either handleUnhandledException pure =<< try dispatch
  where
    dispatch :: IO JSVal
    dispatch = do
        request <- requestFromJSVal requestJSVal
        bindings <- bindingEnvFromJSVal envJSVal
        response <- handler request bindings (WorkersExecutionContext contextJSVal)
        responsetoJSVal response

    handleUnhandledException :: SomeException -> IO JSVal
    handleUnhandledException exception = do
        tailLog (Text.pack ("createFetchHandler: unhandled excetpion -- " <> displayException exception))
        responsetoJSVal internalServerErrorResponse

requestFromJSVal :: JSVal -> IO Request
requestFromJSVal requestJSVal = do
    method <- methodFromText <$> requestMethodText requestJSVal
    urlText <- requestURLText requestJSVal
    url <- case parseURL urlText of
        Just parsedURL -> pure parsedURL
        Nothing -> error ("mkFetchHandler: request.url failed to parse -- " <> Text.unpack urlText)
    headersJSVal <- requestHeadersJSVal requestJSVal
    headers <- headersFromJSVal headersJSVal
    maybeBodyJSVal <- requestBodyJSVal requestJSVal
    let maybeStream = readableStreamFromJSVal <$> maybeBodyJSVal
    maybeDataCenter <- requestDataCenterText requestJSVal
    pure
        ( Request
            method
            url
            maybeStream
            headers
            (fmap (flip readableStreamToLazyByteString) maybeStream)
            maybeDataCenter
        )

internalServerErrorResponse :: Response
internalServerErrorResponse =
    createResponse (Status 500) (headersFromList []) (ResponseBodyBytes "Internal Server Error")

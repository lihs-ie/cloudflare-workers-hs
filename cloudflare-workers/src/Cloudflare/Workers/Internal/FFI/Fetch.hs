module Cloudflare.Workers.Internal.FFI.Fetch (fetchViaFFI) where

import Cloudflare.Workers.HTTP (
    Request,
    Response,
    ResponseBody (ResponseBodyBytes, ResponseBodyStream),
    Status (Status),
    createResponse,
 )
import Cloudflare.Workers.Internal.FFI.Envelope (
    EnvelopeTag (EnvelopeFailureTag, EnvelopeMalformedTag, EnvelopeSuccessTag),
    describeMalformedEnvelope,
    readEnvelopeTag,
 )
import Cloudflare.Workers.Internal.FFI.Headers (headersFromJSVal)
import Cloudflare.Workers.Internal.FFI.Request (requestToJSVal)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Cloudflare.Workers.Internal.Streaming (readableStreamFromJSVal)
import Control.Exception (SomeException, displayException, try)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

fetchViaFFI :: Int -> Request -> IO (Either (Text, Text) (Response, Text))
fetchViaFFI timeoutMilliseconds request = do
    requestOutcome <- try @SomeException (requestToJSVal request)
    case requestOutcome of
        Left failure -> pure (Left ("network", Text.pack (displayException failure)))
        Right requestJSVal -> do
            envelopeJSVal <- jsFetchEnveloped requestJSVal timeoutMilliseconds
            decodeFetchEnvelope envelopeJSVal

decodeFetchEnvelope :: JSVal -> IO (Either (Text, Text) (Response, Text))
decodeFetchEnvelope envelopeJSVal = do
    envelopeTag <- readEnvelopeTag envelopeJSVal
    case envelopeTag of
        EnvelopeSuccessTag -> Right <$> (responseFromJSVal =<< jsEnvelopeValueField envelopeJSVal)
        EnvelopeFailureTag -> do
            kind <- jsValToText =<< jsEnvelopeKindField envelopeJSVal
            message <- jsValToText =<< jsEnvelopeMessageField envelopeJSVal
            pure (Left (kind, message))
        EnvelopeMalformedTag -> do
            description <- describeMalformedEnvelope envelopeJSVal
            pure (Left ("malformed-envelope", description))

responseFromJSVal :: JSVal -> IO (Response, Text)
responseFromJSVal responseJSVal = do
    statusCode <- jsResponseStatus responseJSVal
    statusText <- jsValToText =<< jsResponseStatusText responseJSVal
    headers <- headersFromJSVal =<< jsResponseHeaders responseJSVal
    bodyJSVal <- jsResponseBody responseJSVal
    bodyIsNull <- jsIsNull bodyJSVal
    let body =
            if bodyIsNull
                then ResponseBodyBytes mempty
                else ResponseBodyStream (readableStreamFromJSVal bodyJSVal)
    pure (createResponse (Status statusCode) headers body, statusText)

foreign import javascript safe
    """
    (async () => {
      const controller = new AbortController();
      const timeoutIdentifier = setTimeout(() => controller.abort(), $2);

      try {
        const response = await fetch($1, { signal: controller.signal });
        clearTimeout(timeoutIdentifier);
        return { ok: true, value: response, kind: null, message: null };
      } catch (error) {
        clearTimeout(timeoutIdentifier);

        try {
          if ($1.body) {
            await $1.body.cancel();
          }
        } catch (_) {
        }

        const name = error && error.name;
        const message = String((error && error.message) || error);

        if (name === "AbortError") {
          return { ok: false, value: null, kind: "timeout", message };
        }

        if (/too many subrequests/i.test(message)) {
          return { ok: false, value: null, kind: "subrequest-limit", message };
        }

        return { ok: false, value: null, kind: "network", message };
      }
    })()
    """
    jsFetchEnveloped :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "$1.value"
    jsEnvelopeValueField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.kind"
    jsEnvelopeKindField :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.message"
    jsEnvelopeMessageField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const statusCode = $1.status;

      if (!Number.isSafeInteger(statusCode) || statusCode < 0 || statusCode > 2147483647) {
        throw new TypeError("the fetch Response status is not a non-negative 32-bit integer: " + typeof statusCode);
      }

      return statusCode;
    })()
    """
    jsResponseStatus :: JSVal -> IO Int

foreign import javascript unsafe "$1.headers"
    jsResponseHeaders :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.statusText"
    jsResponseStatusText :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.body"
    jsResponseBody :: JSVal -> IO JSVal

foreign import javascript unsafe "$1 === null"
    jsIsNull :: JSVal -> IO Bool

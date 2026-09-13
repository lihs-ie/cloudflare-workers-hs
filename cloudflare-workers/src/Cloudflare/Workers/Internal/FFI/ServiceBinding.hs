module Cloudflare.Workers.Internal.FFI.ServiceBinding (
    serviceBindingFetchViaFFI,
    serviceBindingCallViaFFI,
) where

import Cloudflare.Workers.HTTP (
    Request,
    Response,
    ResponseBody (ResponseBodyBytes, ResponseBodyStream),
    Status (Status),
    createResponse,
 )
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Headers (headersFromJSVal)
import Cloudflare.Workers.Internal.FFI.Request (requestToJSVal)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Cloudflare.Workers.Internal.Streaming (readableStreamFromJSVal)
import Control.Exception (Exception (displayException), SomeException, try, throwIO)
import Data.Foldable (for_)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

serviceBindingFetchViaFFI :: JSVal -> Request -> IO (Either Text Response)
serviceBindingFetchViaFFI serviceJSVal request = do
    outcome <- try (requestToJSVal request)
    case outcome of
        Left exception -> pure (serviceFetchFailure exception)
        Right requestJSVal -> do
            envelopeJSVal <- jsServiceBindingFetchEnveloped serviceJSVal requestJSVal
            decodeEnvelopedSafely responseFromEnvelopeValue envelopeJSVal
  where
    serviceFetchFailure :: SomeException -> Either Text Response
    serviceFetchFailure = Left . Text.pack . displayException

serviceBindingCallViaFFI :: JSVal -> Text -> [JSVal] -> IO (Either Text JSVal)
serviceBindingCallViaFFI serviceJSVal methodName args = do
    methodNameJSVal <- textToJSVal methodName
    argsArrayJSVal <- jsEmptyArray
    for_ args (jsArrayPush argsArrayJSVal)
    envelopeJSVal <- jsServiceBindingCallEnveloped serviceJSVal methodNameJSVal argsArrayJSVal
    decodeEnveloped pure envelopeJSVal

decodeEnvelopedSafely :: (JSVal -> IO value) -> JSVal -> IO (Either Text value)
decodeEnvelopedSafely decoder envelopeJSVal = do
    outcome <- try (decodeEnveloped decoder envelopeJSVal)
    pure $ case outcome of
        Left exception -> decodeFailure exception
        Right decoded -> decoded
  where
    decodeFailure :: SomeException -> Either Text value
    decodeFailure = Left . Text.pack . displayException

responseFromEnvelopeValue :: JSVal -> IO Response
responseFromEnvelopeValue responseJSVal = do
    statusCodeValue <- jsResponseStatus responseJSVal
    headersJSVal <- jsResponseHeaders responseJSVal
    headers <- headersFromJSVal headersJSVal
    bodyJSVal <- jsResponseBody responseJSVal
    bodyIsNullish <- jsIsNullish bodyJSVal
    let body = if bodyIsNullish then ResponseBodyBytes mempty else ResponseBodyStream (readableStreamFromJSVal bodyJSVal)
    pure (createResponse (Status statusCodeValue) headers body)

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.fetch($2)
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()
    """
    jsServiceBindingFetchEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1[$2](...$3)
        };
      } catch (error) {
        return {
          ok: false,
          message: String(error)
        };
      }
    })()
    """
    jsServiceBindingCallEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      const init = { method: $2, headers: $3};

      if ($4 !== undefined) {
        init.body = $4;

        if ($4 instanceof ReadableStream) {
          init.duplex = "half"
        }

        return new Request($1, init);
      }
    })()
    """
    jsNewRequest :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe "undefined"
    jsUndefinedValue :: IO JSVal

jsResponseStatus :: JSVal -> IO Int
jsResponseStatus input = do
    envelope <- jsResponseStatusEnvelope input
    outcome <- decodeEnveloped jsServiceTrustedInt envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        const statusCode = $1.status;
        if (!Number.isSafeInteger(statusCode) || statusCode < 0 || statusCode > 2147483647) {
        throw new TypeError('the service-binding Response status is not a non-negative 32-bit integer: ' + typeof statusCode);
        }

        return { ok: true, value: statusCode };
      } catch (_) {
        return { ok: false, message: "Could not decode native Service value (jsResponseStatus)" };
      }
    })()
    """
    jsResponseStatusEnvelope :: JSVal -> IO JSVal

jsResponseHeaders :: JSVal -> IO JSVal
jsResponseHeaders input = do
    envelope <- jsResponseHeadersEnvelope input
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.headers };
      } catch (_) {
        return { ok: false, message: "Could not decode native Service value (jsResponseHeaders)" };
      }
    })()
    """
    jsResponseHeadersEnvelope :: JSVal -> IO JSVal

jsResponseBody :: JSVal -> IO JSVal
jsResponseBody input = do
    envelope <- jsResponseBodyEnvelope input
    outcome <- decodeEnveloped pure envelope
    either (throwIO . userError . Text.unpack) pure outcome

foreign import javascript unsafe
    """
    (() => {
      try {
        return { ok: true, value: $1.body };
      } catch (_) {
        return { ok: false, message: "Could not decode native Service value (jsResponseBody)" };
      }
    })()
    """
    jsResponseBodyEnvelope :: JSVal -> IO JSVal

foreign import javascript unsafe "$1 === null || $1 === undefined"
    jsIsNullish :: JSVal -> IO Bool

foreign import javascript unsafe "[]"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push($2)"
    jsArrayPush :: JSVal -> JSVal -> IO ()


-- These decoders see only values validated inside trusted literal envelopes.
foreign import javascript unsafe "$1"
    jsServiceTrustedInt :: JSVal -> IO Int

foreign import javascript unsafe "$1 === true"
    jsServiceTrustedBool :: JSVal -> IO Bool

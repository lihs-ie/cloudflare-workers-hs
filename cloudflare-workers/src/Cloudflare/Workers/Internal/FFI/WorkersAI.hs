module Cloudflare.Workers.Internal.FFI.WorkersAI (
    WorkersAIFailure (..),
    runWorkersAIJSONViaFFI,
    -- runWorkersAIResponseViaFFI,
) where

import Cloudflare.Workers.Internal.Abort (AbortSignal (AbortSignal))
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnvelopedWithError)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

data WorkersAIFailure
    = WorkersAIProviderFailure Text (Maybe Text)
    | WorkersAIInputFailure Text
    | WorkersAIResultFailure Text

runWorkersAIJSONViaFFI ::
    JSVal ->
    Text ->
    Text ->
    Text ->
    Maybe AbortSignal ->
    IO (Either WorkersAIFailure Text)
runWorkersAIJSONViaFFI binding model input options signal = do
    envelope <- runEnvelope binding model input options signal False
    decodeEnvelopedWithError jsValToText decodeFailure malformedFailure envelope

-- runWorkersAIResponseViaFFI ::
--    JSVal ->
--    Text ->
--    Text ->
--    Text ->
--    Maybe AbortSignal ->
--    IO (Either WorkersAIFailure WorkersAIResponse)
-- runWorkersAIResponseViaFFI binding model input options signal = do
--    envelope <- runEnvelope binding model input options signal True
--    decodeEnvelopedWithError decodeResponse decodeFailure malformedFailure envelope

runEnvelope ::
    JSVal ->
    Text ->
    Text ->
    Text ->
    Maybe AbortSignal ->
    Bool ->
    IO JSVal
runEnvelope binding model input options signal responseMode = do
    modelJSVal <- textToJSVal model
    inputJSVal <- textToJSVal input
    optionsJSVal <- textToJSVal options
    signalJS <- maybe jsUndefined (pure . unwrapSignal) signal
    jsRunEnveloped binding modelJSVal inputJSVal optionsJSVal signalJS responseMode
  where
    unwrapSignal (AbortSignal value) = value

decodeFailure :: JSVal -> IO WorkersAIFailure
decodeFailure failure = do
    message <- jsValToText =<< jsFailureMessage failure
    hasName <- jsHasFailureName failure
    name <-
        if hasName
            then Just <$> (jsValToText =<< jsFailureName failure)
            else pure Nothing
    invalid <- jsInvalidResult failure
    invalidInput <- jsInvalidInput failure
    pure
        ( if invalid
            then WorkersAIResultFailure message
            else
                if invalidInput
                    then WorkersAIInputFailure message
                    else WorkersAIProviderFailure message name
        )

malformedFailure :: Text -> WorkersAIFailure
malformedFailure message = WorkersAIProviderFailure message Nothing

-- decodeResponse :: JSVal -> IO WorkersAIResponse
-- decodeResponse value = do
--     status <- Status <$> jsResponseStatus value
--     headers <- headersFromJSVal =<< jsResponseHeaders value
--     noBody <- jsResponseBodyIsNull value
--     body <-
--         if noBody
--             then pure Nothing
--             else
--                 Just . readableStreamFromJSVal <$> jsResponseBody value
--     pure (WorkersAIResponse value status headers body)

foreign import javascript safe
    """
    (async () => {
      let phase = 'input';

      try {
        const finiteNumber = (_key, value) => {
          if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new RangeError('Workers AI input number is outside the JavaScript finite number range');
          }

          return value;
        };

        const input = JSON.parse($3, finiteNumber);
        const options = JSON.parse($4, finiteNumber);

        if (options.gateway?.metadata) {
          for (const key of Object.keys(options.gateway.metadata)) {
            const value = options.gateway.metadata[key];

            if (value !== null && typeof value === 'object' && value.kind === 'bigint') {
              options.gateway.metadata[key] = BigInt(value.value);
            }
          }
        }

        if ($5 !== undefined) { 
          options.signal = $5;
        }

        phase = 'call';

        const result = await $1.run($2, input, options);
        phase = 'result';

        if ($6) {
          if (!(result instanceof Response)) {
            throw new TypeError('Workers AI returned a non-Response in response mode');
          }

          const status = result.status;
          const headers = new Headers(result.headers);

          if (!Number.isInteger(status) || status < 0 || status > 599) { 
            throw new TypeError('Workers AI returned an invalid response status');
          }

          const body = result.body;
          const statusText = result.statusText;
          const webSocket = result.webSocket;
          const cf = result.cf;

          if (body !== null && !(body instanceof ReadableStream)) {
            throw new TypeError('Workers AI returned an invalid response body');
          }

          if (typeof statusText !== 'string') {
            throw new TypeError('Workers AI returned an invalid response status text');
          }

          if (webSocket !== undefined && webSocket !== null && !(webSocket instanceof WebSocket)) { 
            throw new TypeError('Workers AI returned an invalid websocket'); 
          }

          return { 
            ok: true, 
            value: { 
              original: result, 
              status, 
              headers, 
              body, 
              statusText, 
              webSocket, 
              cf 
            }
          };
        }

        const encoded = JSON.stringify(result, (_key, value) => {
          if (typeof value === 'number' && !Number.isFinite(value)) { 
            throw new TypeError('Workers AI returned a non-finite JSON number');
          }

          if (['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) { 
            throw new TypeError('Workers AI returned a non-JSON value');
          }

          return value;
        });

        if (typeof encoded !== 'string') { 
          throw new TypeError('Workers AI returned a non-JSON value');
        }

        return { ok: true, value: encoded };
      } catch (error) {
        let message = 'Workers AI threw an unprintable exception';
        let name = null;
        let hasMessage = false;

        try {
          const candidate = error?.message; 
          if (typeof candidate === 'string') {
            message = candidate; hasMessage = true; }
        } catch (_) {}

        try { 
          const candidate = error?.name;
          if (typeof candidate === 'string') { 
            name = candidate;
          }
        } catch (_) {}
        if (!hasMessage) { 
          try {
            message = String(error); 
          } catch (_) {} }

        return { 
          ok: false, 
          error: {
            message, 
            name, 
            invalid: phase === 'result', 
            invalidInput: phase === 'input' 
          }
        };
      }
    })()
    """
    jsRunEnveloped :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> Bool -> IO JSVal

foreign import javascript unsafe "undefined"
    jsUndefined :: IO JSVal

foreign import javascript unsafe "$1.message"
    jsFailureMessage :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.invalid === true"
    jsInvalidResult :: JSVal -> IO Bool

foreign import javascript unsafe "$1.invalidInput === true"
    jsInvalidInput :: JSVal -> IO Bool

foreign import javascript unsafe "typeof $1.name === 'string'"
    jsHasFailureName :: JSVal -> IO Bool

foreign import javascript unsafe "$1.name"
    jsFailureName :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const status = $1.status; 

      if (!Number.isSafeInteger(status) || status < 0 || status > 2147483647) {
        throw new TypeError('invalid response status'); 
      }

      return status; 
    })()
    """
    jsResponseStatus :: JSVal -> IO Int

foreign import javascript unsafe "$1.headers"
    jsResponseHeaders :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.body === null"
    jsResponseBodyIsNull :: JSVal -> IO Bool

foreign import javascript unsafe "$1.body"
    jsResponseBody :: JSVal -> IO JSVal

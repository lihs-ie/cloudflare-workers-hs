module Cloudflare.Workers.Internal.FFI.NativeResponse (
    createNativeResponseViaFFI,
) where

import Cloudflare.Workers.Headers (Headers, headersToList)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Cloudflare.Workers.Internal.NativeResponse (NativeResponse (NativeResponse), ResponseEncoding (ResponseManual))
import Control.Exception (throwIO)
import Data.Aeson (encode)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)

createNativeResponseViaFFI :: JSVal -> Int -> Headers -> ResponseEncoding -> NativeResponse
createNativeResponseViaFFI snapshot originalStatus originalHeaders encoding =
    NativeResponse $ \requestedStatus requestedHeaders ->
        if requestedStatus == originalStatus && requestedHeaders == originalHeaders
            then jsOriginalResponse snapshot
            else do
                headersJSVal <- textToJSVal (decodeUtf8 (LazyByteString.toStrict (encode (headersToList requestedHeaders))))
                if requestedStatus == originalStatus
                    then renderEnveloped =<< jsResponseWithHeaders snapshot headersJSVal
                    else renderEnveloped =<< jsResponseWithStatus snapshot requestedStatus headersJSVal (encoding == ResponseManual)

renderEnveloped :: JSVal -> IO JSVal
renderEnveloped envelope =
    decodeEnveloped pure envelope >>= either (throwIO . userError . Text.unpack) pure

foreign import javascript unsafe "$1.original"
    jsOriginalResponse :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
      const snapshot = $1;
      const headers = new Headers(JSON.parse($2));
      const response = new Response(snapshot.body, snapshot.original);

      for (const name of Array.from(response.headers.keys())) {
        response.headers.delete(name);
      }

      for (const [name, value] of headers.entries()) {
        if (name.toLowerCase() !== 'set-cookie') {
          response.headers.append(name, value);
        }
      }

      for (const cookie of headers.getSetCookie()) {
        response.headers.append('set-cookie', cookie);
      }

      return { ok: true, value: response };
      } catch (error) {
        let message = 'Native response rendering failed';
        try { 
            message = String(error);
        } catch (_) {
        }


        return { ok: false, message };
      }
    })()
    """
    jsResponseWithHeaders :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try {
      const snapshot = $1;
      const status = $2;

      const response = new Response(
        snapshot.body,
        {
          status,
          headers: new Headers(JSON.parse($2)),
          cf: snapshot.cf,
          websocket: status === 101 ? snapshot.webSocket : null,
          encodeBody: $4 ? 'manual' : 'automatic'
        }
      );

      return { ok: true, value: response };
      } catch (error) {
        let message = 'Native response rendering failed';
        try { 
          message = String(error); 
        } catch (_) {

        }

        return { ok: false, message };
      }
    })()
    """
    jsResponseWithStatus :: JSVal -> Int -> JSVal -> Bool -> IO JSVal

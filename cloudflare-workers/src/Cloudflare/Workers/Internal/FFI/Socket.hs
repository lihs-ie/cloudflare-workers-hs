module Cloudflare.Workers.Internal.FFI.Socket (
  socketConnectViaFFI,
  socketWriteViaFFI,
  socketFinishWriteViaFFI,
  socketOpenedViaFFI,
  socketClosedViaFFI,
  socketCloseViaFFI,
  socketStartTlsViaFFI,
) where

import Data.ByteString (ByteString)
import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)

socketConnectViaFFI :: JSVal -> Either Text (Text, Int) -> Text -> Bool -> IO (Either Text (JSVal, Int, JSVal, JSVal))
socketConnectViaFFI connectorJSVal address secureTransport allowHalfOpen = do
  addressJSVal <- case address of
    Left hostAndPort -> textToJSVal hostAndPort
    Right (hostname, port) -> do
      addressObjectJSVal <- jsEmptyObject
      textToJSVal hostname >>= jsSetSocketAddressHostname addressObjectJSVal
      jsSetSocketAddressPort addressObjectJSVal port
      pure addressObjectJSVal
  optionsJSVal <- jsEmptyObject
  textToJSVal secureTransport >>= jsSetSocketOptionSecureTransport optionsJSVal
  jsSetSocketOptionAllowHalfOpen optionsJSVal allowHalfOpen
  decodeEnveloped decodeSocket =<< jsSocketConnectEnveloped connectorJSVal addressJSVal optionsJSVal

socketOpenedViaFFI :: JSVal -> IO (Either Text (Maybe Text, Maybe Text))
socketOpenedViaFFI socketJSVal = decodeEnveloped decodeSocketInfo =<< jsSocketOpenedEnveloped socketJSVal

socketClosedViaFFI :: JSVal -> IO (Either Text ())
socketClosedViaFFI socketJSVal = decodeEnveloped (const (pure ())) =<< jsSocketClosedEnveloped socketJSVal

socketCloseViaFFI :: JSVal -> IO (Either Text ())
socketCloseViaFFI socketJSVal = decodeEnveloped (const (pure ())) =<< jsSocketCloseEnveloped socketJSVal

socketStartTlsViaFFI :: JSVal -> IO (Either Text (JSVal, Int, JSVal, JSVal))
socketStartTlsViaFFI socketJSVal = decodeEnveloped decodeSocket =<< jsSocketStartTlsEnveloped socketJSVal

decodeSocket :: JSVal -> IO (JSVal, Int, JSVal, JSVal)
decodeSocket socketJSVal = do
  socketIdentifier <- jsSocketIdentifier socketJSVal
  readableJSVal <- jsSocketReadable socketJSVal
  writableJSVal <- jsSocketWritable socketJSVal
  pure (socketJSVal, socketIdentifier, readableJSVal, writableJSVal)

decodeSocketInfo :: JSVal -> IO (Maybe Text, Maybe Text)
decodeSocketInfo infoJSVal = do
  remoteAddress <- readOptionalText =<< jsSocketInfoRemoteAddressOrNull infoJSVal
  localAddress <- readOptionalText =<< jsSocketInfoLocalAddressOrNull infoJSVal
  pure (remoteAddress, localAddress)

readOptionalText :: JSVal -> IO (Maybe Text)
readOptionalText valueJSVal = do
  isNull <- jsIsNullish valueJSVal
  if isNull then pure Nothing else Just <$> jsValToText valueJSVal

foreign import javascript safe
  """
  (async () => {
    try {
      const socket = $1($2, $3);
      // Observe both independent promises without replacing them: callers can
      // still await and inspect their original rejections through the API.
      socket.opened.catch(() => {});
      socket.closed.catch(() => {});
      return { ok: true, value: socket };
    }
    catch (error) { return { ok: false, message: String(error) }; }
  })()
  """
  jsSocketConnectEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { return { ok: true, value: await $1.opened }; } catch (error) { return { ok: false, message: String(error) }; } })()"
  jsSocketOpenedEnveloped :: JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { await $1.closed; return { ok: true, value: null }; } catch (error) { return { ok: false, message: String(error) }; } })()"
  jsSocketClosedEnveloped :: JSVal -> IO JSVal

foreign import javascript safe "(async () => { try { await $1.close(); return { ok: true, value: null }; } catch (error) { return { ok: false, message: String(error) }; } })()"
  jsSocketCloseEnveloped :: JSVal -> IO JSVal

-- An upgraded socket owns two independent promises, just like connect().
-- Observe both immediately so a closed rejection cannot escape while opened
-- is being inspected. Preserve the originals for the public result methods.
foreign import javascript safe
  """
  (async () => {
    try {
      const socket = $1.startTls();
      socket.opened.catch(() => {});
      socket.closed.catch(() => {});
      return { ok: true, value: socket };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  })()
  """
  jsSocketStartTlsEnveloped :: JSVal -> IO JSVal

foreign import javascript unsafe "({})" jsEmptyObject :: IO JSVal
foreign import javascript unsafe "$1.hostname = $2" jsSetSocketAddressHostname :: JSVal -> JSVal -> IO ()
foreign import javascript unsafe "$1.port = $2" jsSetSocketAddressPort :: JSVal -> Int -> IO ()
foreign import javascript unsafe "$1.secureTransport = $2" jsSetSocketOptionSecureTransport :: JSVal -> JSVal -> IO ()
foreign import javascript unsafe "$1.allowHalfOpen = !!$2" jsSetSocketOptionAllowHalfOpen :: JSVal -> Bool -> IO ()
foreign import javascript unsafe "$1.readable" jsSocketReadable :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.writable" jsSocketWritable :: JSVal -> IO JSVal

foreign import javascript unsafe
  """
  (() => {
    if (globalThis.__cloudflareWorkersHsSocketIdentifiers === undefined) {
      globalThis.__cloudflareWorkersHsSocketIdentifiers = { next: 1, values: new WeakMap() };
    }
    const table = globalThis.__cloudflareWorkersHsSocketIdentifiers;
    if (!table.values.has($1)) {
      table.values.set($1, table.next++);
    }
    return table.values.get($1);
  })()
  """
  jsSocketIdentifier :: JSVal -> IO Int

foreign import javascript unsafe "typeof $1.remoteAddress === 'string' ? $1.remoteAddress : null" jsSocketInfoRemoteAddressOrNull :: JSVal -> IO JSVal
foreign import javascript unsafe "typeof $1.localAddress === 'string' ? $1.localAddress : null" jsSocketInfoLocalAddressOrNull :: JSVal -> IO JSVal
foreign import javascript unsafe "$1 === null || $1 === undefined" jsIsNullish :: JSVal -> IO Bool

socketWriteViaFFI :: JSVal -> ByteString -> IO (Either Text ())
socketWriteViaFFI socket bytes = do
  chunk <- byteStringToJSByteArray bytes
  decodeEnveloped (const (pure ())) =<< jsSocketWriteEnveloped socket chunk

socketFinishWriteViaFFI :: JSVal -> IO (Either Text ())
socketFinishWriteViaFFI socket = decodeEnveloped (const (pure ())) =<< jsSocketFinishWriteEnveloped socket

foreign import javascript safe
  "(async () => { let writer; try { writer = $1.writable.getWriter(); await writer.write($2); return { ok: true, value: null }; } catch (error) { return { ok: false, message: String(error) }; } finally { if (writer) writer.releaseLock(); } })()"
  jsSocketWriteEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
  "(async () => { let writer; try { writer = $1.writable.getWriter(); await writer.close(); return { ok: true, value: null }; } catch (error) { return { ok: false, message: String(error) }; } finally { if (writer) writer.releaseLock(); } })()"
  jsSocketFinishWriteEnveloped :: JSVal -> IO JSVal

module Cloudflare.Workers.Entrypoint.DurableObject (
    WebSocketConnection (..),
    WebSocketState (..),
    webSocketPair,
    webSocketUpgradeResponse,
    webSocketAcceptHibernating,
    webSocketConnections,
    webSocketSetAttachment,
    webSocketGetAttachment,
    webSocketClose,
    webSocketSetAutoResponse,
    WebSocketMessagePayload (..),
    WebSocketError (..),
    WebSocketMessageHandler,
    WebSocketCloseHandler,
    webSocketSend,
    createWebSocketMessageHandler,
    createWebSocketMessageHandlerWithLimit,
    createWebSocketCloseHandler,
) where

import Cloudflare.Workers.Entrypoint.Env (bindingEnvFromJSVal)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.HTTP (PassthroughResponse (..), Response, ResponseBody (..), Status (..), createResponse)
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Internal.FFI.BindingEnv (BuildBindingEnv, BuildDOSEnv)
import Cloudflare.Workers.Internal.FFI.DurableObject (webSocketCloseCodeViaFFI, webSocketCloseWasCleanViaFFI, webSocketMessageBytesViaFFI, webSocketMessageIsTextViaFFI, webSocketMessageTextViaFFI, webSocketSendBytesViaFFI, webSocketSendTextViaFFI)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (Exception, throwIO)
import Control.Monad (when)
import Data.Aeson (FromJSON, ToJSON, eitherDecodeStrict', encode)
import Data.ByteString (ByteString)
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (decodeUtf8, encodeUtf8)
import GHC.Wasm.Prim (JSVal)

newtype WebSocketConnection = WebSocketConnection JSVal

data WebSocketMessagePayload
    = WebSocketTextMessage Text
    | WebSocketBinaryMessage ByteString
    deriving stock (Show, Eq)

data WebSocketError = WebSocketSendFailed Text | WebSocketMessageTooLarge Int
    deriving stock (Show, Eq)

instance Exception WebSocketError

type WebSocketMessageHandler env = WebSocketConnection -> WebSocketMessagePayload -> env -> IO ()

type WebSocketCloseHandler env = WebSocketConnection -> Int -> Text -> Bool -> env -> IO ()

webSocketSend :: WebSocketConnection -> WebSocketMessagePayload -> IO ()
webSocketSend (WebSocketConnection webSocketJSVal) payload = do
    outcome <- case payload of
        WebSocketTextMessage text -> webSocketSendTextViaFFI webSocketJSVal text
        WebSocketBinaryMessage bytes -> webSocketSendBytesViaFFI webSocketJSVal bytes
    either (throwIO . WebSocketSendFailed) pure outcome

createWebSocketMessageHandler ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    WebSocketMessageHandler (BindingEnv kvs dos bindings) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createWebSocketMessageHandler handler webSocketJSVal messageJSVal envJSVal = do
    message <- webSocketMessagePayloadFromJSVal messageJSVal
    bindings <- bindingEnvFromJSVal envJSVal
    handler (WebSocketConnection webSocketJSVal) message bindings

{- | Reject oversized native frames before copying bytes/text into WASM.
Applications can catch 'WebSocketMessageTooLarge' and close with code 1009.
-}
createWebSocketMessageHandlerWithLimit ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    Int ->
    WebSocketMessageHandler (BindingEnv kvs dos bindings) ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createWebSocketMessageHandlerWithLimit limit handler socket message env = do
    when (limit < 0) $ throwIO (WebSocketSendFailed "Invalid WebSocket message byte limit")
    oversized <- jsMessageExceeds message limit
    if oversized
        then throwIO (WebSocketMessageTooLarge limit)
        else createWebSocketMessageHandler handler socket message env

foreign import javascript unsafe "typeof $1 === 'string' ? ($1.length > $2 || new TextEncoder().encode($1).byteLength > $2) : $1.byteLength > $2"
    jsMessageExceeds :: JSVal -> Int -> IO Bool

createWebSocketCloseHandler ::
    forall kvs dos bindings.
    (BuildBindingEnv bindings, BuildDOSEnv dos) =>
    WebSocketCloseHandler (BindingEnv kvs dos bindings) ->
    JSVal ->
    JSVal ->
    JSVal ->
    JSVal ->
    JSVal ->
    IO ()
createWebSocketCloseHandler handler webSocketJSVal codeJSVal reasonJSVal wasCleanJSVal envJSVal = do
    code <- webSocketCloseCodeViaFFI codeJSVal
    reason <- jsValToText reasonJSVal
    wasClean <- webSocketCloseWasCleanViaFFI wasCleanJSVal
    bindings <- bindingEnvFromJSVal envJSVal
    handler (WebSocketConnection webSocketJSVal) code reason wasClean bindings

webSocketMessagePayloadFromJSVal :: JSVal -> IO WebSocketMessagePayload
webSocketMessagePayloadFromJSVal messageJSVal = do
    isText <- webSocketMessageIsTextViaFFI messageJSVal
    if isText
        then WebSocketTextMessage <$> webSocketMessageTextViaFFI messageJSVal
        else WebSocketBinaryMessage <$> webSocketMessageBytesViaFFI messageJSVal

{- | DurableObjectState, not a global connection registry. Hibernation state
remains in the platform and attachments, so reconstructed instances recover.
-}
newtype WebSocketState = WebSocketState JSVal

webSocketPair :: IO (WebSocketConnection, WebSocketConnection)
webSocketPair = do
    pair <- jsPair
    ((,) . WebSocketConnection <$> jsFirst pair) <*> (WebSocketConnection <$> jsSecond pair)

webSocketUpgradeResponse :: WebSocketConnection -> IO Response
webSocketUpgradeResponse (WebSocketConnection client) = do
    raw <- jsUpgrade client
    pure (createResponse (Status 101) (headersFromList []) (ResponseBodyWebSocket (PassthroughResponse raw)))

webSocketAcceptHibernating :: WebSocketState -> WebSocketConnection -> [Text] -> IO ()
webSocketAcceptHibernating (WebSocketState state) (WebSocketConnection socket) tags = do
    raw <- textToJSVal (decodeUtf8 (Lazy.toStrict (encode tags)))
    webSocketOutcome =<< jsAccept state socket raw

webSocketConnections :: WebSocketState -> Maybe Text -> IO [WebSocketConnection]
webSocketConnections (WebSocketState state) tag = do
    rawTag <- textToJSVal (decodeUtf8 (Lazy.toStrict (encode tag)))
    result <- either (throwIO . WebSocketSendFailed) pure =<< (decodeEnveloped pure =<< jsConnections state rawTag)
    count <- jsCount result
    traverse (fmap WebSocketConnection . jsAt result) [0 .. count - 1]

webSocketSetAttachment :: (ToJSON a) => WebSocketConnection -> a -> IO ()
webSocketSetAttachment (WebSocketConnection socket) value = do
    raw <- textToJSVal (decodeUtf8 (Lazy.toStrict (encode value)))
    webSocketOutcome =<< jsSetAttachment socket raw

webSocketGetAttachment :: (FromJSON a) => WebSocketConnection -> IO (Maybe a)
webSocketGetAttachment (WebSocketConnection socket) = do
    outcome <- decodeEnveloped jsValToText =<< jsGetAttachment socket
    raw <- either (throwIO . WebSocketSendFailed) pure outcome
    either (throwIO . WebSocketSendFailed . Text.pack) pure (eitherDecodeStrict' (encodeUtf8 raw))

webSocketClose :: WebSocketConnection -> Int -> Text -> IO ()
webSocketClose (WebSocketConnection socket) code reason = do
    raw <- textToJSVal reason
    webSocketOutcome =<< jsClose socket code raw

webSocketSetAutoResponse :: WebSocketState -> Maybe (Text, Text) -> IO ()
webSocketSetAutoResponse (WebSocketState state) pair = do
    raw <- textToJSVal (decodeUtf8 (Lazy.toStrict (encode pair)))
    webSocketOutcome =<< jsAutoResponse state raw

webSocketOutcome :: JSVal -> IO ()
webSocketOutcome raw = either (throwIO . WebSocketSendFailed) pure =<< decodeEnveloped (const (pure ())) raw

foreign import javascript unsafe "Object.values(new WebSocketPair())" jsPair :: IO JSVal
foreign import javascript unsafe "$1[0]" jsFirst :: JSVal -> IO JSVal
foreign import javascript unsafe "$1[1]" jsSecond :: JSVal -> IO JSVal
foreign import javascript unsafe "new Response(null, {status:101,webSocket:$1})" jsUpgrade :: JSVal -> IO JSVal
foreign import javascript unsafe "(() => {try {$1.acceptWebSocket($2,JSON.parse($3));return {ok:true,value:null};}catch(e){return {ok:false,message:String(e)};}})()"
    jsAccept :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "(() => {try {return {ok:true,value:$1.getWebSockets(JSON.parse($2) ?? undefined)};}catch(e){return {ok:false,message:String(e)};}})()" jsConnections :: JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "$1.length" jsCount :: JSVal -> IO Int
foreign import javascript unsafe "$1[$2]" jsAt :: JSVal -> Int -> IO JSVal
foreign import javascript unsafe "(() => {try {$1.serializeAttachment(JSON.parse($2));return {ok:true,value:null};}catch(e){return {ok:false,message:String(e)};}})()"
    jsSetAttachment :: JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "(() => {try {return {ok:true,value:JSON.stringify($1.deserializeAttachment() ?? null)};}catch(e){return {ok:false,message:String(e)};}})()"
    jsGetAttachment :: JSVal -> IO JSVal
foreign import javascript unsafe "(() => {try {$1.close($2,$3);return {ok:true,value:null};}catch(e){return {ok:false,message:String(e)};}})()"
    jsClose :: JSVal -> Int -> JSVal -> IO JSVal
foreign import javascript unsafe "(() => {try {const p=JSON.parse($2);$1.setWebSocketAutoResponse(p === null ? undefined : new WebSocketRequestResponsePair(p[0],p[1]));return {ok:true,value:null};}catch(e){return {ok:false,message:String(e)};}})()"
    jsAutoResponse :: JSVal -> JSVal -> IO JSVal

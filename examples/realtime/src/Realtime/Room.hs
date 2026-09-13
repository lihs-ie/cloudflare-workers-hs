module Realtime.Room (initialize, server, onMessage, onClose) where
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Binding.DurableObject.SQL
import Cloudflare.Workers.Entrypoint.DurableObject
import Cloudflare.Workers.Headers (headerLookup, headersFromList, headerInsert)
import Cloudflare.Workers.HTTP
import Control.Exception (try)
import Control.Monad (forM_, void)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson
import Data.ByteString qualified as Bytes
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8)
import Realtime.API
import Servant.Cloudflare.Workers.Server (Server)

initialize :: DurableObjectStorage -> WebSocketState -> IO ()
initialize storage state = do
  void $ sqlBatch storage sqlDefaultLimits
    [ SQLStatement "CREATE TABLE IF NOT EXISTS messages (identifier INTEGER PRIMARY KEY AUTOINCREMENT, connection TEXT NOT NULL, body BLOB NOT NULL, kind TEXT NOT NULL)" []
    , SQLStatement "CREATE TABLE IF NOT EXISTS events (identifier INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL)" []
    , SQLStatement "INSERT INTO events(kind) VALUES('constructor')" []
    ]
  setting <- doStorageGet storage "auto-response-disabled"
  webSocketSetAutoResponse state (if setting == Just "true" then Nothing else Just ("ping", "pong"))

server :: DurableObjectStorage -> WebSocketState -> Text -> Server RoomAPI ()
server storage state connectionIdentifier = RoomRoutes
  { connect = connectWith "chat" connectionIdentifier
  , monitor = connectWith "monitor" ("monitor:" <> connectionIdentifier)
  , history = liftIO $ do
      result <- sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT identifier, connection, body, kind FROM messages ORDER BY identifier DESC LIMIT 100" [])
      pure (object ["columns" .= columns result, "rows" .= rows result])
  , autoResponse = \enabled -> liftIO $ do
      doStoragePut storage "auto-response-disabled" (if enabled then "false" else "true")
      webSocketSetAutoResponse state (if enabled then Just ("ping", "pong") else Nothing)
      pure (object ["enabled" .= enabled])
  , allConnections = liftIO $ do
      sockets <- webSocketConnections state Nothing
      attachments <- traverse (webSocketGetAttachment @Text) sockets
      pure (object ["count" .= length sockets, "attachments" .= attachments])
  , connections = liftIO $ do
      sockets <- webSocketConnections state (Just "chat")
      attachments <- traverse (webSocketGetAttachment @Text) sockets
      result <- sqlExecute storage sqlDefaultLimits (SQLStatement "SELECT COUNT(*) FROM events WHERE kind = 'constructor'" [])
      let boots = case rows result of [[SQLNumber count]] -> count; _ -> 0
      pure (object ["count" .= length sockets, "attachments" .= attachments, "constructors" .= boots])
  }
  where
    connectWith tag attachment _ request _ =
      if requestMethod request /= GET
      then pure (createResponse (Status 405) (headersFromList [("Allow", "GET")]) (ResponseBodyBytes "GET required"))
      else if fmap Text.toCaseFold (headerLookup "Upgrade" (requestHeaders request)) /= Just "websocket"
      then pure (createResponse (Status 426) (headersFromList []) (ResponseBodyBytes "WebSocket upgrade required"))
      else do
        (client, socket) <- webSocketPair
        webSocketSetAttachment socket attachment
        webSocketAcceptHibernating state socket [tag]
        webSocketSend socket (WebSocketTextMessage ("connected:" <> attachment))
        upgraded <- webSocketUpgradeResponse client
        pure upgraded{responseHeaders = headerInsert "x-realtime" "haskell" (responseHeaders upgraded)}


onMessage :: DurableObjectStorage -> WebSocketState -> WebSocketConnection -> WebSocketMessagePayload -> IO ()
onMessage storage state socket payload = do
  decoded <- try @WebSocketError (webSocketGetAttachment @Text socket)
  case decoded of
    Left _ -> webSocketClose socket 1008 "Invalid connection attachment"
    Right Nothing -> webSocketClose socket 1008 "Missing connection attachment"
    Right (Just connection) | "monitor:" `Text.isPrefixOf` connection -> webSocketClose socket 1008 "Monitor connections cannot publish"
    Right (Just connection) -> do
      let (kind, bytes) = case payload of
            WebSocketTextMessage text -> ("text", encodeUtf8 text)
            WebSocketBinaryMessage binary -> ("binary", binary)
      if Bytes.length bytes > 4096 then webSocketClose socket 1009 "Message exceeds 4096 bytes"
      else do
        void $ sqlExecute storage sqlDefaultLimits (SQLStatement "INSERT INTO messages(connection,body,kind) VALUES(?,?,?)" [SQLText connection, SQLBlob bytes, SQLText kind])
        sockets <- webSocketConnections state (Just "chat")
        forM_ sockets $ \peer -> do
          _ <- try @WebSocketError (webSocketSend peer payload)
          pure ()

onClose :: DurableObjectStorage -> WebSocketConnection -> Int -> Text -> Bool -> IO ()
onClose storage socket _ _ _ = do
  void $ sqlExecute storage sqlDefaultLimits (SQLStatement "INSERT INTO events(kind) VALUES(?)" [SQLText "closed"])
  _ <- try @WebSocketError (webSocketClose socket 1000 "Closed")
  pure ()

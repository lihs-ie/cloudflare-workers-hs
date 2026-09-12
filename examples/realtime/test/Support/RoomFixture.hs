module Support.RoomFixture (oversizedMessage) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectStorage)
import Cloudflare.Workers.Entrypoint.DurableObject
    ( WebSocketConnection, WebSocketMessagePayload (WebSocketTextMessage), WebSocketState )
import Data.Text qualified as Text
import Realtime.Room qualified as Room

-- Exercise the room callback's own defensive limit independently of the
-- entrypoint decoder, which rejects oversized messages before dispatch.
oversizedMessage :: DurableObjectStorage -> WebSocketState -> WebSocketConnection -> IO ()
oversizedMessage storage state socket =
    Room.onMessage storage state socket (WebSocketTextMessage (Text.replicate 4097 "x"))

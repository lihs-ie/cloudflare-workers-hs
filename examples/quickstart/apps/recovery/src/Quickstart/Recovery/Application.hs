{-# LANGUAGE DataKinds, TypeOperators #-}
module Quickstart.Recovery.Application (RecoveryAPI, RecoveryRoutes(..),recoveryHandler) where
import Cloudflare.Workers.Binding.D1
import Control.Monad.Except (throwError)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (Value,object,(.=))
import Data.Text (Text)
import Data.Maybe (fromMaybe)
import GHC.Generics (Generic)
import Servant.API
import Servant.API.Generic ((:-))
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Error
import Quickstart.Background.Environment
import Quickstart.Database
import URLShortener.Domain (ClickEvent)

data RecoveryRoutes mode = RecoveryRoutes
    { getEvents :: mode :- "events" :> QueryParam "after" Text :> Get '[JSON] [Value]
    , replayEvent :: mode :- "events" :> Capture "identifier" Text :> "replay" :> Verb 'POST 202 '[JSON] Value
    }
    deriving stock (Generic)

type RecoveryAPI = NamedRoutes RecoveryRoutes

recoveryHandler :: BackgroundEnv -> Server RecoveryAPI BackgroundEnv
recoveryHandler env = RecoveryRoutes {getEvents = listEvents, replayEvent = replay}
 where
  listEvents cursor = liftIO $ do
    now <- currentTime env
    rows <- query (database env) "SELECT identifier,url,occurred_at,status,last_error FROM failed_events WHERE identifier>? AND expires_at>? ORDER BY identifier LIMIT 100"
      [D1Text (fromMaybe "" cursor),timeValue now]
    traverse (\row -> do
      identifier <- textColumn "identifier" row
      url <- textColumn "url" row
      occurred <- textColumn "occurred_at" row
      state <- textColumn "status" row
      pure (object ["identifier" .= identifier,"url" .= url,"occurredAt" .= occurred,"status" .= state])) rows
  replay identifier = do
    now <- liftIO (currentTime env)
    existing <- liftIO $ first (database env) "SELECT payload FROM failed_events WHERE identifier=? AND expires_at>?" [D1Text identifier,timeValue now]
    row <- maybe (throwError err404) pure existing
    liftIO $ do
      payload <- textColumn "payload" row >>= decodeText @ClickEvent
      sendJSON (clickQueue env) payload
      _ <- execute (database env) "UPDATE failed_events SET status='requeued' WHERE identifier=?" [D1Text identifier]
      pure (object ["identifier" .= identifier,"status" .= ("requeued" :: Text)])

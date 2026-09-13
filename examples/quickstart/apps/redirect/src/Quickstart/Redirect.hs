module Quickstart.Redirect (API, Routes (..), RedirectEnv (..), server) where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.Queue
import Cloudflare.Workers.Middleware (generateRequestId)
import Cloudflare.Workers.Observability (tailLog)
import Cloudflare.Workers.Reactor (waitUntil)
import Control.Exception (SomeException, catch)
import Control.Monad (void)
import Control.Monad.Except (throwError)
import Control.Monad.IO.Class (liftIO)
import Control.Monad.Reader (ask)
import Data.Text (Text)
import Data.Time (UTCTime)
import GHC.Generics (Generic)
import Quickstart.Database qualified as DB
import Servant.API
import Servant.API.Generic ((:-))
import Servant.Cloudflare.Workers.Error (err404)
import Servant.Cloudflare.Workers.Handler (Handler, askExecutionContext)
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Server.Internal ()
import URLShortener.Domain (ClickEvent (..))

newtype Routes mode = Routes
    { redirect :: mode :- "r" :> Capture "code" Text :> Verb 'GET 302 '[JSON] (Headers '[Header "Location" Text, Header "Cache-Control" Text] NoContent)
    }
    deriving stock (Generic)

type API = NamedRoutes Routes

data RedirectEnv = RedirectEnv {database :: D1, clicks :: QueueProducer, now :: IO UTCTime}

server :: Server API RedirectEnv
server = Routes{redirect = redirectURL}

redirectURL :: Text -> Handler RedirectEnv (Headers '[Header "Location" Text, Header "Cache-Control" Text] NoContent)
redirectURL code = do
    environment <- ask
    occurred <- liftIO (now environment)
    row <-
        liftIO $
            DB.first
                (database environment)
                "SELECT destination FROM urls WHERE identifier = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
                [D1Text code, DB.timeValue occurred]
    case row of
        Nothing -> throwError err404
        Just value -> do
            destination <- liftIO (DB.textColumn "destination" value)
            context <- askExecutionContext
            liftIO $
                waitUntil context $
                    ( do
                        eventIdentifier <- generateRequestId
                        let event = ClickEvent eventIdentifier code occurred
                        void $ queueSendValue (clicks environment) (QueueJSONBody (DB.jsonText event)) queueSendDefaultOptions
                    )
                        `catch` (\(_ :: SomeException) -> tailLog "click_event_send_failed")
            pure (addHeader destination (addHeader ("no-store" :: Text) NoContent))

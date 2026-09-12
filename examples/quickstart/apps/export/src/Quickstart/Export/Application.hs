{-# LANGUAGE DataKinds, TypeOperators, DeriveGeneric #-}
module Quickstart.Export.Application (ExportAPI, ExportRoutes(..), ExportRequest(..), exportHandler) where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.R2
import Cloudflare.Workers.Streaming (ReadableStream)
import Control.Monad.Except (throwError)
import Control.Exception (SomeException, try)
import Control.Monad.IO.Class (liftIO)
import Data.Aeson (FromJSON,ToJSON,Value,object,(.=))
import Data.Text (Text)
import Data.Text qualified as T
import Data.Time (Day, diffDays)
import GHC.Generics (Generic)
import Servant.API
import Servant.API.Generic ((:-))
import Network.HTTP.Media ((//), (/:))
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Server.Internal ()
import Servant.Cloudflare.Workers.Error
import Quickstart.Background.Environment
import Quickstart.Database

data ExportRequest = ExportRequest {startDay :: Day, endDay :: Day}
  deriving stock (Show,Eq,Generic)
instance FromJSON ExportRequest
instance ToJSON ExportRequest

data CSV
instance Accept CSV where
  contentType _ = "text" // "csv" /: ("charset", "utf-8")

data ExportRoutes mode = ExportRoutes
    { createExport :: mode :- "exports" :> ReqBody '[JSON] ExportRequest :> Verb 'POST 202 '[JSON] Value
    , getExport :: mode :- "exports" :> Capture "identifier" Text :> Get '[JSON] Value
    , downloadExport :: mode :- "exports" :> Capture "identifier" Text :> "download" :> Stream 'GET 200 NoFraming CSV (Headers '[Header "Content-Disposition" Text, Header "Cache-Control" Text] ReadableStream)
    }
    deriving stock (Generic)

type ExportAPI = NamedRoutes ExportRoutes

exportHandler :: BackgroundEnv -> Server ExportAPI BackgroundEnv
exportHandler env = ExportRoutes {createExport = create, getExport = status, downloadExport = download}
 where
  create request = do
    let days = diffDays (endDay request) (startDay request) + 1
    if days < 1 || days > 366 then throwError (withDetail "Date range must contain 1 to 366 UTC days" err400) else pure ()
    result <- liftIO $ do
      identifier <- newIdentifier env
      now <- currentTime env
      _ <- execute (database env) "INSERT INTO exports(identifier,start_day,end_day,status,requested_by,created_at,object_key) VALUES(?,?,?,'pending',?,?,?)"
        [D1Text identifier,D1Text (dayText (startDay request)),D1Text (dayText (endDay request)),D1Text (administrator env),timeValue now,D1Text ("exports/" <> identifier <> ".csv")]
      -- Persisted pending rows form an outbox; maintenance retries delivery.
      delivery <- try @SomeException (sendJSON (exportQueue env) (object ["identifier" .= identifier]))
      case delivery of
        Right () -> pure ()
        Left _ -> do
          _ <- execute (database env) "UPDATE exports SET last_error='Initial queue delivery failed; pending retry' WHERE identifier=?" [D1Text identifier]
          pure ()
      pure (object ["identifier" .= identifier,"status" .= ("pending" :: Text)])
    pure result
  status identifier = do
    row <- lookupExport identifier
    liftIO $ do
      state <- textColumn "status" row
      snapshot <- pure (lookup "snapshot_at" row)
      pure (object ["identifier" .= identifier,"status" .= state,"snapshotAt" .= nullableText snapshot])
  lookupExport identifier = do
    now <- liftIO (currentTime env)
    row <- liftIO (first (database env) "SELECT * FROM exports WHERE identifier=? AND (expires_at IS NULL OR expires_at>?)" [D1Text identifier,timeValue now])
    maybe (throwError err404) pure row
  download identifier = do
    row <- lookupExport identifier
    state <- liftIO (textColumn "status" row)
    if state /= "complete" then throwError (ServerError 409 "Export is not complete" [] Nothing) else pure ()
    key <- liftIO (textColumn "object_key" row)
    result <- liftIO (r2Get (bucket env) key r2GetDefaultOptions)
    case result of
      R2GetSuccess value -> pure (addHeader ("attachment; filename=\"" <> identifier <> ".csv\"" :: Text) (addHeader ("private, no-store" :: Text) (r2ObjectBody value)))
      _ -> throwError err404

dayText :: Day -> Text
dayText = T.pack . show

nullableText :: Maybe D1Value -> Maybe Text
nullableText (Just (D1Text value)) = Just value
nullableText _ = Nothing

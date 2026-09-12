module Quickstart.Maintenance.Application (runMaintenance) where
import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.R2
import Control.Monad (forM_,void)
import Data.Aeson (object,(.=))
import Data.Text (Text)
import Quickstart.Background.Environment
import Quickstart.Database

-- Each invocation does bounded work. Expiration checks in request handlers are
-- authoritative; delayed cleanup never extends the lifetime of a record.
runMaintenance :: BackgroundEnv -> IO ()
runMaintenance env = do
  now <- currentTime env
  forM_ ["admin_idempotency","click_events","failed_events"] $ \table ->
    void $ execute db ("DELETE FROM " <> table <> " WHERE rowid IN (SELECT rowid FROM " <> table <> " WHERE expires_at<=? LIMIT 100)") [timeValue now]
  expired <- query db "SELECT identifier,object_key FROM exports WHERE expires_at<=? ORDER BY expires_at LIMIT 100" [timeValue now]
  forM_ expired $ \row -> do
    identifier <- textColumn "identifier" row
    key <- textColumn "object_key" row
    r2Delete (bucket env) key
    void $ execute db "DELETE FROM exports WHERE identifier=? AND expires_at<=?" [D1Text identifier,timeValue now]
  -- Outbox recovery: an accepted request survives producer/network failure.
  pending <- query db "SELECT identifier FROM exports WHERE status IN ('pending','generating') ORDER BY coalesce(last_enqueued_at,created_at),identifier LIMIT 100" []
  forM_ pending $ \row -> do
    identifier <- textColumn "identifier" row
    void $ execute db "UPDATE exports SET last_enqueued_at=? WHERE identifier=?" [timeValue now,D1Text identifier]
    sendJSON (exportQueue env) (object ["identifier" .= (identifier :: Text)])
 where db = database env

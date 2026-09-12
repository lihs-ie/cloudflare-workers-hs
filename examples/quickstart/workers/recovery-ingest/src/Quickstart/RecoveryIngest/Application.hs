module Quickstart.RecoveryIngest.Application (ingestFailedClick) where
import Cloudflare.Workers.Binding.D1
import Control.Monad (void)
import Data.Time (UTCTime)
import URLShortener.Domain
import Quickstart.Database

-- Caller acknowledges each message only after this durable write succeeds.
ingestFailedClick :: D1 -> UTCTime -> ClickEvent -> IO ()
ingestFailedClick db now event@(ClickEvent identifier url occurred) = void $ execute db
  "INSERT OR IGNORE INTO failed_events(identifier,url,occurred_at,payload,status,last_error,expires_at) VALUES(?,?,?,?,?,'Queue retries exhausted',?)"
  [D1Text identifier,D1Text url,timeValue occurred,D1Text (jsonText event),D1Text (if eventWithinWindow now event then "failed" else "expired"),timeValue (eventExpiresAt occurred)]

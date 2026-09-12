module Quickstart.Aggregation.Application (aggregateClick) where
import Cloudflare.Workers.Binding.D1
import Data.Time (UTCTime)
import Control.Monad (void)
import URLShortener.Domain
import Quickstart.Database

-- The migration's AFTER INSERT trigger increments the daily total in the same
-- transaction. INSERT OR IGNORE makes concurrent deliveries count exactly once.
-- Events originate only from successful redirects. Current expiry is deliberately
-- not consulted: an administrator may have changed it since the click occurred.
aggregateClick :: D1 -> UTCTime -> ClickEvent -> IO ()
aggregateClick db now event@(ClickEvent identifier url occurred)
  | not (eventWithinWindow now event) = void $ execute db
      "INSERT OR IGNORE INTO failed_events(identifier,url,occurred_at,payload,status,last_error,expires_at) VALUES(?,?,?,?,'expired','Event outside processing window',?)"
      [D1Text identifier,D1Text url,timeValue occurred,D1Text (jsonText event),timeValue (eventExpiresAt occurred)]
  | otherwise = do
      void $ execute db
        "INSERT OR IGNORE INTO click_events(identifier,url,occurred_at,expires_at) SELECT ?,identifier,?,? FROM urls WHERE identifier=? AND created_at<=? AND (deleted_at IS NULL OR deleted_at>?)"
        [D1Text identifier,timeValue occurred,timeValue (eventExpiresAt occurred),D1Text url,timeValue occurred,timeValue occurred]
      void $ execute db "UPDATE failed_events SET status='processed',last_error=NULL WHERE identifier=? AND EXISTS(SELECT 1 FROM click_events WHERE identifier=?)" [D1Text identifier,D1Text identifier]

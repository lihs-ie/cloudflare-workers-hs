module LibraryExamples.Database (catalogExample) where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query
import Data.Aeson (Value, object, (.=))
import Data.Maybe (isJust)
import Data.Text (Text)

-- An idempotent seed-and-read walkthrough. SQL identifiers are static and all
-- application values are bound parameters, including text containing quotes.
catalogExample :: D1 -> IO Value
catalogExample database = do
    setup <- d1Exec database "CREATE TABLE IF NOT EXISTS example_catalog (identifier TEXT PRIMARY KEY, title TEXT NOT NULL, enabled INTEGER NOT NULL)"
    prepared <- d1Prepare database "INSERT INTO example_catalog VALUES (?, ?, ?) ON CONFLICT(identifier) DO UPDATE SET title=excluded.title, enabled=excluded.enabled"
    bound <- d1Bind prepared [D1Text "guide", D1Text "Worker's guide", D1Integer 1]
    written <- d1Run bound
    selected <- d1Prepare database "SELECT identifier,title,enabled FROM example_catalog WHERE identifier=?"
    query <- d1Bind selected [D1Text "guide"]
    first <- d1First query
    allRows <- d1All query
    typed <- d1QueryFirst database (D1Statement "SELECT title FROM example_catalog WHERE identifier=?" [D1Text "guide"]) (d1Column "title" d1Text)
    pure $
        object
            [ "written" .= d1RunResultSuccess written
            , "setup" .= object ["count" .= d1ExecResultCount setup, "durationMs" .= d1ExecResultDuration setup]
            , "writeMeta" .= metadata (d1RunResultMeta written)
            , "readMeta" .= metadata (d1ResultMeta allRows)
            , "firstPresent" .= isJust first
            , "rows" .= length (d1ResultResults allRows)
            , "title" .= (typed :: Maybe Text)
            ]

-- Diagnostics preserve native counters, rather than deriving read/write counts
-- from the result array. Execution duration is variable and expressed in ms.
metadata :: D1Meta -> Value
metadata meta =
    object
        [ "durationMs" .= d1MetaDuration meta
        , "changes" .= d1MetaChanges meta
        , "lastRowIdentifier" .= d1MetaLastRowID meta
        , "rowsRead" .= d1MetaRowsRead meta
        , "rowsWritten" .= d1MetaRowsWritten meta
        ]

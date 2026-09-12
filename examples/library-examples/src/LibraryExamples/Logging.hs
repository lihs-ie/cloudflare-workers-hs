module LibraryExamples.Logging (loggingExample) where

import Cloudflare.Workers.Observability
import Data.Aeson (Value, object, (.=))
import Data.Text (Text)

-- Three operational logging profiles: troubleshooting, warning monitoring,
-- and error-only reporting. Sample rates 0 and 1 are deterministic.
loggingExample :: Text -> IO Value
loggingExample profile = do
  config <- case profile of
    "diagnostics" -> pure (LoggerConfig LogDebug 1)
    "warnings" -> pure (LoggerConfig LogWarn 1)
    "errors-only" -> pure (LoggerConfig LogDebug 0)
    _ -> fail "Unknown logging profile"
  let identifier = "logging-policy-" <> profile
      report level message = emitLog config LogRecord
        { logRecordLevel = level
        , logRecordRequestId = identifier
        , logRecordRayId = Nothing
        , logRecordMethod = Just "POST"
        , logRecordPath = Just ("/logging/" <> profile)
        , logRecordStatus = Nothing
        , logRecordDurationMs = Nothing
        , logRecordErrorKind = if level == LogError then Just "processing_failed" else Nothing
        , logRecordMessage = message
        }
  -- A fixed processing report demonstrates how each profile retains or omits
  -- diagnostic, progress, warning and failure records without logging payloads.
  report LogDebug "input validation started"
  report LogInfo "work accepted"
  report LogWarn "retry scheduled"
  report LogError "processing failed"
  pure $ object ["profile" .= profile, "reported" .= True]

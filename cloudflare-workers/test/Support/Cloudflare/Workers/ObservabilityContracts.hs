module Support.Cloudflare.Workers.ObservabilityContracts (observabilityContracts) where

import Cloudflare.Workers.Env (BindingMissingError (BindingMissingError))
import Cloudflare.Workers.Observability
import Control.Monad (forM_, unless)
import Data.Aeson (ToJSON (..), Value, eitherDecode)
import Data.Aeson.Encoding (encodingToLazyByteString)

-- Public instance contracts shared by the host and actual WASM consumers:
-- severity ordering drives threshold selection; diagnostics describe configuration
-- and recoverable errors; batch JSON must agree with individual JSON records.
observabilityContracts :: IO ()
observabilityContracts = do
    let levels = [LogDebug, LogInfo, LogWarn, LogError]
    forM_ (zip [0 :: Int ..] levels) $ \(rank, level) -> do
        diagnostic level (if level == LogError then LogInfo else LogError) (showLevel level)
        jsonContract level
        forM_ (zip [0 :: Int ..] levels) $ \(otherRank, other) -> do
            check "severity comparison" (compare level other == compare rank otherRank)
            check "severity less than" ((level < other) == (rank < otherRank))
            check "severity at most" ((level <= other) == (rank <= otherRank))
            check "severity greater than" ((level > other) == (rank > otherRank))
            check "severity at least" ((level >= other) == (rank >= otherRank))
            check "maximum threshold" (max level other == levels !! max rank otherRank)
            check "minimum threshold" (min level other == levels !! min rank otherRank)
    let config = LoggerConfig LogInfo 1
    diagnostic config (LoggerConfig LogWarn 0)
        "LoggerConfig {loggerConfigMinLevel = LogInfo, loggerConfigSampleRate = 1.0}"
    let record = LogRecord LogInfo "contract" Nothing Nothing Nothing Nothing Nothing Nothing "message"
        changed = record {logRecordMessage = "different"}
    diagnostic record changed
        ("LogRecord {logRecordLevel = LogInfo, logRecordRequestId = \"contract\", "
        ++ "logRecordRayId = Nothing, logRecordMethod = Nothing, logRecordPath = Nothing, "
        ++ "logRecordStatus = Nothing, logRecordDurationMs = Nothing, logRecordErrorKind = Nothing, "
        ++ "logRecordMessage = \"message\"}")
    jsonContract record
    -- Configuration recovery can compare errors and present several missing
    -- bindings as one diagnostic without exposing any secret binding values.
    diagnostic (BindingMissingError "REQUIRED_VAR") (BindingMissingError "OTHER_VAR")
        "BindingMissingError \"REQUIRED_VAR\""
  where
    showLevel LogDebug = "LogDebug"
    showLevel LogInfo = "LogInfo"
    showLevel LogWarn = "LogWarn"
    showLevel LogError = "LogError"

check :: String -> Bool -> IO ()
check label condition = unless condition (fail ("Observability contract: " ++ label))

diagnostic :: (Show value, Eq value) => value -> value -> String -> IO ()
diagnostic value different expected = do
    check "single diagnostic" (show value == expected)
    check "composed diagnostic" (showsPrec 0 value "; next" == expected ++ "; next")
    check "batch diagnostic" (showList [value] "" == "[" ++ expected ++ "]")
    check "same configuration" (value == value)
    check "different configuration" (value /= different)

jsonContract :: ToJSON value => value -> IO ()
jsonContract value = do
    check "single encoding" ((eitherDecode (encodingToLazyByteString (toEncoding value)) :: Either String Value) == Right (toJSON value))
    check "batch encoding" ((eitherDecode (encodingToLazyByteString (toEncodingList [value])) :: Either String Value) == Right (toJSONList [value]))
    check "batch JSON shape" (toJSONList [value] == toJSON [toJSON value])
    check "required record field" (not (omitField value))

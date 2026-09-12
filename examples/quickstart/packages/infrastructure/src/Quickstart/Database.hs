module Quickstart.Database where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query qualified as Query
import Data.Text (Text)
import Data.Text qualified as T
import Data.Time
import Data.Aeson (ToJSON, FromJSON, encode, eitherDecodeStrict')
import Data.Text.Encoding qualified as TE
import Data.ByteString.Lazy qualified as LBS
import Control.Exception (throwIO)

type Row = Query.D1Row
prepare :: D1 -> Text -> [D1Value] -> IO D1PreparedStatement
prepare db sql values = Query.d1PrepareQuery db (Query.D1Statement sql values)
query :: D1 -> Text -> [D1Value] -> IO [Row]
query db sql values = Query.d1Query db (Query.D1Statement sql values) Query.d1RawRow
first :: D1 -> Text -> [D1Value] -> IO (Maybe Row)
first db sql values = Query.d1QueryFirst db (Query.D1Statement sql values) Query.d1RawRow
execute :: D1 -> Text -> [D1Value] -> IO D1RunResult
execute db sql values = Query.d1Execute db (Query.D1Statement sql values)
batch :: D1 -> [(Text, [D1Value])] -> IO [D1RunResult]
batch db statements = Query.d1ExecuteBatch db (map (uncurry Query.D1Statement) statements)
textColumn :: Text -> Row -> IO Text
textColumn key = Query.decodeD1RowOrThrow (Query.d1Column key Query.d1Text)
integerColumn :: Text -> Row -> IO Integer
integerColumn key = Query.decodeD1RowOrThrow (Query.d1Column key Query.d1Integer)
-- A fixed-width UTC representation keeps SQLite text comparisons chronological.
timeText :: UTCTime -> Text
timeText = T.pack . formatTime defaultTimeLocale "%Y-%m-%dT%H:%M:%S.%qZ"
timeValue :: UTCTime -> D1Value
timeValue = D1Text . timeText
optionalTimeValue :: Maybe UTCTime -> D1Value
optionalTimeValue = maybe D1Null timeValue
jsonText :: ToJSON a => a -> Text
jsonText = TE.decodeUtf8 . LBS.toStrict . encode
decodeText :: FromJSON a => Text -> IO a
decodeText value = either (throwIO . userError) pure (eitherDecodeStrict' (TE.encodeUtf8 value))

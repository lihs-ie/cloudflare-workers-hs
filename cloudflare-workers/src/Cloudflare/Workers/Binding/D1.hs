module Cloudflare.Workers.Binding.D1 (
    D1 (..),
    D1PreparedStatement (..),
    D1Value (..),
    D1Meta (..),
    D1Result (..),
    D1RunResult (..),
    D1ExecResult (..),
    D1ExecutionError (..),
    d1Prepare,
    d1Bind,
    d1All,
    d1First,
    d1Run,
    d1Batch,
    d1Exec,
    classifyD1RawErrorMessage,
) where

import Cloudflare.Workers.Internal.FFI.D1 (
    D1MetaViaFFI,
    D1ValueViaFFI (D1BlobViaFFI, D1IntegerViaFFI, D1NullViaFFI, D1RealViaFFI, D1TextViaFFI),
    d1AllViaFFI,
    d1BatchViaFFI,
    d1BindViaFFI,
    d1ExecViaFFI,
    d1FirstViaFFI,
    d1PrepareViaFFI,
    d1RunViaFFI,
 )
import Control.Exception (Exception, throwIO)
import Data.ByteString (ByteString)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

newtype D1 = D1 JSVal

newtype D1PreparedStatement = D1PreparedStatement JSVal

data D1Value
    = D1Null
    | D1Integer Integer
    | D1Real Double
    | D1Text Text
    | D1Blob ByteString
    deriving stock (Show, Eq)

data D1Meta = D1Meta
    { d1MetaDuration :: Double
    , d1MetaChanges :: Maybe Int
    , d1MetaLastRowID :: Maybe Integer
    , d1MetaRowsRead :: Maybe Integer
    , d1MetaRowsWritten :: Maybe Integer
    }
    deriving stock (Show, Eq)

data D1Result = D1Result
    { d1ResultResults :: [[(Text, D1Value)]]
    , d1ResultSuccess :: Bool
    , d1ResultMeta :: D1Meta
    }
    deriving stock (Show, Eq)

data D1RunResult = D1RunResult
    { d1RunResultSuccess :: Bool
    , d1RunResultMeta :: D1Meta
    }
    deriving stock (Show, Eq)

data D1ExecResult = D1ExecResult
    { d1ExecResultCount :: Int
    , d1ExecResultDuration :: Double
    }
    deriving stock (Show, Eq)

data D1ExecutionError
    = D1ConstraintViolation Text
    | D1SyntaxError Text
    | D1UnknownError Text
    deriving stock (Show, Eq)

instance Exception D1ExecutionError

d1Prepare :: D1 -> Text -> IO D1PreparedStatement
d1Prepare (D1 databaseJSValue) sql = D1PreparedStatement <$> d1PrepareViaFFI databaseJSValue sql

d1Bind :: D1PreparedStatement -> [D1Value] -> IO D1PreparedStatement
d1Bind (D1PreparedStatement preparedStatementJSValue) values =
    D1PreparedStatement <$> d1BindViaFFI preparedStatementJSValue (fmap toD1ValueViaFFI values)

d1All :: D1PreparedStatement -> IO D1Result
d1All (D1PreparedStatement preparedStatementJSValue) = do
    outcome <- d1AllViaFFI preparedStatementJSValue
    either (throwIO . classifyD1RawErrorMessage) (pure . toD1Result) outcome
  where
    toD1Result (rawRows, success, rawMeta) =
        D1Result
            { d1ResultResults = fmap (fmap (fmap fromD1ValueViaFFI)) rawRows
            , d1ResultSuccess = success
            , d1ResultMeta = toD1Meta rawMeta
            }

d1First :: D1PreparedStatement -> IO (Maybe [(Text, D1Value)])
d1First (D1PreparedStatement preparedStatementJSValue) = do
    outcome <- d1FirstViaFFI preparedStatementJSValue
    either (throwIO . classifyD1RawErrorMessage) (pure . (fmap . fmap . fmap) fromD1ValueViaFFI) outcome

d1Run :: D1PreparedStatement -> IO D1RunResult
d1Run (D1PreparedStatement preparedStatementJSValue) = do
    outcome <- d1RunViaFFI preparedStatementJSValue
    either (throwIO . classifyD1RawErrorMessage) (pure . toD1RunResult) outcome

d1Batch :: D1 -> [D1PreparedStatement] -> IO [D1RunResult]
d1Batch (D1 databaseJSValue) preparedStatements = do
    outcome <- d1BatchViaFFI databaseJSValue (fmap unwrapD1PreparedStatement preparedStatements)
    either (throwIO . classifyD1RawErrorMessage) (pure . fmap toD1RunResult) outcome
  where
    unwrapD1PreparedStatement (D1PreparedStatement preparedStatementJSValue) = preparedStatementJSValue

d1Exec :: D1 -> Text -> IO D1ExecResult
d1Exec (D1 databaseJSValue) sql = do
    outcome <- d1ExecViaFFI databaseJSValue sql
    either (throwIO . classifyD1RawErrorMessage) (pure . toD1ExecResult) outcome

classifyD1RawErrorMessage :: Text -> D1ExecutionError
classifyD1RawErrorMessage rawMessage
    | any (`Text.isInfixOf` rawMessage) constraintSubstrings = D1ConstraintViolation rawMessage
    | any (`Text.isInfixOf` rawMessage) syntaxSubstrings = D1SyntaxError rawMessage
    | otherwise = D1UnknownError rawMessage
  where
    constraintSubstrings =
        [ "UNIQUE constraint"
        , "FOREIGN KEY constraint"
        , "CHECK constraint"
        , "NOT NULL constraint"
        , "SQLITE_CONSTRAINT"
        ]
    syntaxSubstrings = ["syntax error", "SQLITE_ERROR"]

toD1ValueViaFFI :: D1Value -> D1ValueViaFFI
toD1ValueViaFFI D1Null = D1NullViaFFI
toD1ValueViaFFI (D1Integer integerValue) = D1IntegerViaFFI integerValue
toD1ValueViaFFI (D1Real realValue) = D1RealViaFFI realValue
toD1ValueViaFFI (D1Text textValue) = D1TextViaFFI textValue
toD1ValueViaFFI (D1Blob blobValue) = D1BlobViaFFI blobValue

fromD1ValueViaFFI :: D1ValueViaFFI -> D1Value
fromD1ValueViaFFI D1NullViaFFI = D1Null
fromD1ValueViaFFI (D1IntegerViaFFI integerValue) = D1Integer integerValue
fromD1ValueViaFFI (D1RealViaFFI realValue) = D1Real realValue
fromD1ValueViaFFI (D1TextViaFFI textValue) = D1Text textValue
fromD1ValueViaFFI (D1BlobViaFFI blobValue) = D1Blob blobValue

toD1Meta :: D1MetaViaFFI -> D1Meta
toD1Meta (duration, changes, lastRowID, rowsRead, rowsWritten) = do
    D1Meta
        { d1MetaDuration = duration
        , d1MetaChanges = changes
        , d1MetaLastRowID = lastRowID
        , d1MetaRowsRead = rowsRead
        , d1MetaRowsWritten = rowsWritten
        }

toD1RunResult :: (Bool, D1MetaViaFFI) -> D1RunResult
toD1RunResult (success, rawMeta) = D1RunResult{d1RunResultSuccess = success, d1RunResultMeta = toD1Meta rawMeta}

toD1ExecResult :: (Int, Double) -> D1ExecResult
toD1ExecResult (count, duration) = D1ExecResult{d1ExecResultCount = count, d1ExecResultDuration = duration}

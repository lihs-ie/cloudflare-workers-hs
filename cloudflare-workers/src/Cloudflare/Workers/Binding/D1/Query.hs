-- | Parameterized D1 execution and composable row decoders. SQL and schema
-- remain application-owned; no query text is built by interpolating parameters.
module Cloudflare.Workers.Binding.D1.Query
    ( D1Row, D1Statement (..), D1RowDecoder, D1ValueDecoder
    , D1ColumnType (..), D1DecodeError (..), D1QueryError (..)
    , decodeD1Row, decodeD1Rows, decodeD1RowOrThrow, d1RawRow
    , d1Column, d1Nullable, d1Text, d1Integer, d1Double, d1Blob, d1Bool, d1BoundedInt, d1Refine
    , validateD1Statement, d1PrepareQuery, d1Query, d1QueryFirst, d1Execute, d1ExecuteBatch
    ) where

import Cloudflare.Workers.Binding.D1
import Control.Exception (Exception, throwIO)
import Data.ByteString (ByteString)
import Data.Text (Text)

type D1Row = [(Text, D1Value)]
data D1Statement = D1Statement
    { d1StatementSQL :: Text
    , d1StatementParameters :: [D1Value]
    } deriving stock (Show, Eq)

data D1ColumnType = D1NullType | D1TextType | D1IntegerType | D1RealType | D1BlobType
    deriving stock (Show, Eq)
data D1DecodeError
    = D1MissingColumn Text
    | D1UnexpectedNull Text
    | D1ColumnTypeMismatch Text D1ColumnType D1ColumnType
    | D1InvalidColumnValue Text Text
    deriving stock (Show, Eq)
instance Exception D1DecodeError

-- | Row numbers are one-based. The exception contains no SQL or bound values.
-- Native execution failures retain the existing D1ExecutionError type.
data D1QueryError
    = D1RowDecodeFailed Int D1DecodeError
    | D1InvalidParameter Int Text
    | D1UnsuccessfulResult Text
    deriving stock (Show, Eq)
instance Exception D1QueryError

newtype D1RowDecoder a = D1RowDecoder {decodeD1Row :: D1Row -> Either D1DecodeError a}
instance Functor D1RowDecoder where
    fmap f (D1RowDecoder decoder) = D1RowDecoder (fmap f . decoder)
instance Applicative D1RowDecoder where
    pure value = D1RowDecoder (const (Right value))
    D1RowDecoder f <*> D1RowDecoder g = D1RowDecoder (\row -> f row <*> g row)
instance Monad D1RowDecoder where
    D1RowDecoder decoder >>= next = D1RowDecoder (\row -> decoder row >>= \value -> decodeD1Row (next value) row)

data ValueIssue = NullValue | WrongType D1ColumnType D1ColumnType | InvalidValue Text
newtype D1ValueDecoder a = D1ValueDecoder (D1Value -> Either ValueIssue a)
instance Functor D1ValueDecoder where
    fmap f (D1ValueDecoder decoder) = D1ValueDecoder (fmap f . decoder)

-- | Nullable accepts SQL NULL only. A missing projected column remains an error.
d1Nullable :: D1ValueDecoder a -> D1ValueDecoder (Maybe a)
d1Nullable (D1ValueDecoder decoder) = D1ValueDecoder $ \value -> case value of
    D1Null -> Right Nothing
    other -> Just <$> decoder other

d1Column :: Text -> D1ValueDecoder a -> D1RowDecoder a
d1Column name (D1ValueDecoder decoder) = D1RowDecoder $ \row -> case lookup name row of
    Nothing -> Left (D1MissingColumn name)
    Just value -> case decoder value of
        Right result -> Right result
        Left NullValue -> Left (D1UnexpectedNull name)
        Left (WrongType expected actual) -> Left (D1ColumnTypeMismatch name expected actual)
        Left (InvalidValue message) -> Left (D1InvalidColumnValue name message)

-- NULL has its own error contract; no type-name conversion for NULL is needed.
mismatch :: D1ColumnType -> D1Value -> Either ValueIssue a
mismatch expected value = case value of
    D1Null -> Left NullValue
    D1Text{} -> wrong D1TextType
    D1Integer{} -> wrong D1IntegerType
    D1Real{} -> wrong D1RealType
    D1Blob{} -> wrong D1BlobType
  where
    wrong actual = Left (WrongType expected actual)

d1Text :: D1ValueDecoder Text
d1Text = D1ValueDecoder $ \value -> case value of D1Text text -> Right text; other -> mismatch D1TextType other
d1Integer :: D1ValueDecoder Integer
d1Integer = D1ValueDecoder $ \value -> case value of
    D1Integer number | abs number > 9007199254740991 -> Left (InvalidValue "integer exceeds exact JavaScript numeric range")
                     | otherwise -> Right number
    other -> mismatch D1IntegerType other
d1Blob :: D1ValueDecoder ByteString
d1Blob = D1ValueDecoder $ \value -> case value of D1Blob bytes -> Right bytes; other -> mismatch D1BlobType other

-- | JavaScript/D1 cannot retain the distinction between 1.0 and 1. Both numeric
-- representations are accepted. Non-finite reals and unsafe integer conversion
-- fail rather than silently overflowing or losing integer precision.
d1Double :: D1ValueDecoder Double
d1Double = D1ValueDecoder $ \value -> case value of
    D1Real number | isNaN number || isInfinite number -> Left (InvalidValue "non-finite numeric value")
                  | otherwise -> Right number
    D1Integer number | abs number > 9007199254740991 -> Left (InvalidValue "integer exceeds exact JavaScript numeric range")
                     | otherwise -> Right (fromInteger number)
    other -> mismatch D1RealType other

d1Bool :: D1ValueDecoder Bool
d1Bool = d1Refine (\value -> case value of 0 -> Right False; 1 -> Right True; _ -> Left "boolean must be stored as integer 0 or 1") d1Integer

d1BoundedInt :: D1ValueDecoder Int
d1BoundedInt = d1Refine bounded d1Integer
  where
    bounded value
        | value < toInteger (minBound :: Int) || value > toInteger (maxBound :: Int) = Left "integer is outside the Int range"
        | otherwise = Right (fromInteger value)

-- | Add application-owned validation, such as decoding JSON stored in TEXT.
-- Messages should describe the failure without copying sensitive column values.
d1Refine :: (a -> Either Text b) -> D1ValueDecoder a -> D1ValueDecoder b
d1Refine validate (D1ValueDecoder decoder) = D1ValueDecoder $ \value -> do
    decoded <- decoder value
    either (Left . InvalidValue) Right (validate decoded)

-- | Explicit escape hatch: no output validation, including numeric precision.
-- Use typed column decoders when consuming raw rows returned through this path.
d1RawRow :: D1RowDecoder D1Row
d1RawRow = D1RowDecoder Right

decodeD1Rows :: D1RowDecoder a -> [D1Row] -> Either D1QueryError [a]
decodeD1Rows decoder rows = traverse decode (zip [1 ..] rows)
  where
    decode (index, row) = either (Left . D1RowDecodeFailed index) Right (decodeD1Row decoder row)
decodeD1RowOrThrow :: D1RowDecoder a -> D1Row -> IO a
decodeD1RowOrThrow decoder = either throwIO pure . decodeD1Row decoder

-- | Validate bound numeric values before crossing the JavaScript boundary.
-- Large SQLite integers must be bound/read as TEXT and decoded by the caller.
validateD1Statement :: D1Statement -> Either D1QueryError ()
validateD1Statement (D1Statement _ parameters) = mapM_ validate (zip [1 ..] parameters)
  where
    validate (index, D1Integer value)
        | abs value > 9007199254740991 = Left (D1InvalidParameter index "integer exceeds exact JavaScript numeric range")
    validate (index, D1Real value)
        | isNaN value || isInfinite value = Left (D1InvalidParameter index "non-finite numeric value")
    validate _ = Right ()

d1PrepareQuery :: D1 -> D1Statement -> IO D1PreparedStatement
d1PrepareQuery database statement@(D1Statement sql parameters) = do
    either throwIO pure (validateD1Statement statement)
    d1Prepare database sql >>= (`d1Bind` parameters)

d1Query :: D1 -> D1Statement -> D1RowDecoder a -> IO [a]
d1Query database statement decoder = do
    result <- d1PrepareQuery database statement >>= d1All
    if d1ResultSuccess result
        then either throwIO pure (decodeD1Rows decoder (d1ResultResults result))
        else throwIO (D1UnsuccessfulResult "query")
d1QueryFirst :: D1 -> D1Statement -> D1RowDecoder a -> IO (Maybe a)
d1QueryFirst database statement decoder = do
    row <- d1PrepareQuery database statement >>= d1First
    traverse (either (throwIO . D1RowDecodeFailed 1) pure . decodeD1Row decoder) row
d1Execute :: D1 -> D1Statement -> IO D1RunResult
d1Execute database statement = do
    result <- d1PrepareQuery database statement >>= d1Run
    if d1RunResultSuccess result then pure result else throwIO (D1UnsuccessfulResult "execute")

-- | D1's native batch is used once, preserving its transaction semantics.
-- It is not emulated with a sequence of independent execute calls.
d1ExecuteBatch :: D1 -> [D1Statement] -> IO [D1RunResult]
d1ExecuteBatch _ [] = pure []
d1ExecuteBatch database statements = do
    prepared <- traverse (d1PrepareQuery database) statements
    results <- d1Batch database prepared
    if all d1RunResultSuccess results && length results == length statements
        then pure results
        else throwIO (D1UnsuccessfulResult "batch")

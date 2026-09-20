-- | Eager, bounded SQL results. 'sqlExec' calls native sql.exec directly;
-- 'sqlExecute' and 'sqlBatch' wrap execution in native transactionSync.
-- No cursor crosses an await.
module Cloudflare.Workers.Binding.DurableObject.SQL
  ( SQLValue(..), SQLStatement(..), SQLResult(..), SQLLimits(..), sqlDefaultLimits
  , SQLError(..), sqlExec, sqlExecute, sqlBatch
  ) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectStorage(..))
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal, jsValToText)
import Control.Exception (Exception, throwIO)
import Control.Monad (unless)
import Data.Aeson
import Data.ByteString qualified as Bytes
import Data.ByteString.Lazy qualified as Lazy
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding (encodeUtf8, decodeUtf8)
import GHC.Wasm.Prim (JSVal)

data SQLValue = SQLNull | SQLText Text | SQLNumber Double | SQLBlob Bytes.ByteString
  deriving stock (Show, Eq)
data SQLStatement = SQLStatement { sql :: Text, parameters :: [SQLValue] }
  deriving stock (Show, Eq)
data SQLResult = SQLResult { columns :: [Text], rows :: [[SQLValue]], rowsRead :: Int, rowsWritten :: Int }
  deriving stock (Show, Eq)
data SQLLimits = SQLLimits { maximumRows :: Int, maximumBytes :: Int, maximumStatements :: Int }
  deriving stock (Show, Eq)
sqlDefaultLimits :: SQLLimits
sqlDefaultLimits = SQLLimits 1000 1048576 32
newtype SQLError = SQLError Text deriving stock (Show, Eq)
instance Exception SQLError

instance ToJSON SQLValue where
  toJSON SQLNull = object ["tag" .= ("null" :: Text)]
  toJSON (SQLText text) = object ["tag" .= ("text" :: Text), "value" .= text]
  toJSON (SQLNumber number) = object ["tag" .= ("number" :: Text), "value" .= number]
  toJSON (SQLBlob bytes) = object ["tag" .= ("blob" :: Text), "value" .= Bytes.unpack bytes]
instance FromJSON SQLValue where
  parseJSON = withObject "SQLValue" $ \o -> do
    tag <- o .: "tag"
    case (tag :: Text) of
      "null" -> pure SQLNull
      "text" -> SQLText <$> o .: "value"
      "number" -> SQLNumber <$> o .: "value"
      "blob" -> SQLBlob . Bytes.pack <$> o .: "value"
      _ -> fail "Unknown SQL value tag"
instance ToJSON SQLStatement where
  toJSON statement = object ["sql" .= sql statement, "parameters" .= parameters statement]
instance FromJSON SQLResult where
  parseJSON = withObject "SQLResult" $ \o -> SQLResult <$> o .: "columns" <*> o .: "rows" <*> o .: "rowsRead" <*> o .: "rowsWritten"

sqlExecute :: DurableObjectStorage -> SQLLimits -> SQLStatement -> IO SQLResult
sqlExecute storage limits statement = do
  result <- sqlBatch storage limits [statement]
  case result of [single] -> pure single; _ -> throwIO (SQLError "Unexpected SQL result count")

-- | Call native sql.exec without introducing transactionSync. Results are
-- consumed synchronously before returning across JSFFI, using the same bounded
-- encoding as 'sqlExecute'. Inside 'doStorageTransactionWith', this participates
-- in the enclosing native transaction. Unlike 'sqlExecute', an output decoding
-- or limit failure does not itself roll back writes: let the exception escape
-- the enclosing callback when rollback is required.
sqlExec :: DurableObjectStorage -> SQLLimits -> SQLStatement -> IO SQLResult
sqlExec storage limits statement = do
  result <- executePlan False storage limits [statement]
  case result of [single] -> pure single; _ -> throwIO (SQLError "Unexpected SQL result count")

sqlBatch :: DurableObjectStorage -> SQLLimits -> [SQLStatement] -> IO [SQLResult]
sqlBatch = executePlan True

executePlan :: Bool -> DurableObjectStorage -> SQLLimits -> [SQLStatement] -> IO [SQLResult]
executePlan atomic (DurableObjectStorage storage) limits statements = do
  unless (maximumRows limits >= 0 && maximumRows limits <= 10000 && maximumBytes limits > 0 && maximumBytes limits <= 16777216 && maximumStatements limits > 0 && maximumStatements limits <= 128)
    (throwIO (SQLError "Invalid SQL result limits"))
  unless (length statements <= maximumStatements limits && all validStatement statements)
    (throwIO (SQLError "Invalid SQL statement or parameter"))
  -- Bound serialization before constructing JSON (a large blob expands to an
  -- array of numbers on this bridge). Conservative UTF-16 escaping is safe.
  unless (sum (map inputCost statements) <= toInteger (maximumBytes limits))
    (throwIO (SQLError "SQL input exceeds byte limit"))
  let plan = encode statements
  unless (Lazy.length plan <= fromIntegral (maximumBytes limits)) (throwIO (SQLError "SQL input exceeds byte limit"))
  raw <- textToJSVal (decodeUtf8 (Lazy.toStrict plan))
  outcome <- decodeEnveloped jsValToText =<< jsSQLBatch storage raw (maximumRows limits) (maximumBytes limits) atomic
  text <- either (throwIO . SQLError) pure outcome
  either (throwIO . SQLError . Text.pack) pure (eitherDecodeStrict' (encodeUtf8 text))
  where
    inputCost statement = 64 + toInteger (Text.length (sql statement)) * 6 + sum (map valueCost (parameters statement))
    valueCost SQLNull = 32
    valueCost (SQLText value) = 32 + toInteger (Text.length value) * 6
    valueCost (SQLNumber _) = 64
    valueCost (SQLBlob value) = 32 + toInteger (Bytes.length value) * 4
    validStatement statement = not (Text.null (Text.strip (sql statement))) && Text.length (sql statement) <= 65536 && length (parameters statement) <= 100 && all validValue (parameters statement)
    validValue (SQLNumber x) = not (isNaN x || isInfinite x) && (abs x <= 9007199254740991 || x /= fromInteger (round x))
    validValue _ = True

foreign import javascript unsafe
  """
  (() => {
    try {
      const plan = JSON.parse($2);
      let rowCount = 0, byteCount = 0;
      const count = n => {
        byteCount += n;
        if (byteCount > $4) {
          throw new Error('SQL output exceeds byte limit');
        }
      };
      const encode = value => {
        if (value === null) {
          count(1);
          return {tag:'null'};
        }
        if (typeof value === 'string') {
          count(value.length * 2);
          return {tag:'text',value};
        }
        if (typeof value === 'number') {
          if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
            throw new Error('SQL number cannot be represented safely');
          }
          count(8);
          return {tag:'number',value};
        }
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
        count(bytes.byteLength); return {tag:'blob',value:Array.from(bytes)};
      };
      const decode = item => item.tag === 'null' ? null : item.tag === 'blob' ? new Uint8Array(item.value).buffer : item.value;
      const execute = () => plan.map(statement => {
        const cursor = $1.sql.exec(statement.sql, ...statement.parameters.map(decode));
        const columns = cursor.columnNames;
        columns.forEach(name => count(name.length * 2));
        const rows = [];
        for (const row of cursor.raw()) {
          if (++rowCount > $3) {
            throw new Error('SQL output exceeds row limit');
          }
          rows.push(row.map(encode));
        }
        return {columns,rows,rowsRead:cursor.rowsRead,rowsWritten:cursor.rowsWritten};
      });
      const results = $5 ? $1.transactionSync(execute) : execute();
      return {ok:true,value:JSON.stringify(results)};
    } catch (error) {
      let message = 'SQL operation failed with an unprintable error';
      try { message = String(error); } catch (_) {}
      return {ok:false,message};
    }
  })()
  """
  jsSQLBatch :: JSVal -> JSVal -> Int -> Int -> Bool -> IO JSVal

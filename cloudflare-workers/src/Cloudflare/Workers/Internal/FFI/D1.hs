module Cloudflare.Workers.Internal.FFI.D1 (
    D1ValueViaFFI (..),
    D1MetaViaFFI,
    d1PrepareViaFFI,
    d1BindViaFFI,
    d1AllViaFFI,
    d1FirstViaFFI,
    d1RunViaFFI,
    d1BatchViaFFI,
    d1ExecViaFFI,
) where

import Cloudflare.Workers.Internal.FFI.Bytes (byteStringToJSByteArray, jsByteArrayToByteString)
import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Control.Exception (throwIO)
import Control.Monad (forM, (<=<))
import Data.ByteString (ByteString)
import Data.Foldable (for_)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

data D1PreparedStatement = D1PreparedStatementSTUB
    deriving stock (Show, Eq)

data D1ValueViaFFI
    = D1NullViaFFI
    | D1IntegerViaFFI Integer
    | D1RealViaFFI Double
    | D1TextViaFFI Text
    | D1BlobViaFFI ByteString
    deriving stock (Show, Eq)

type D1MetaViaFFI = (Double, Maybe Int, Maybe Integer, Maybe Integer, Maybe Integer)

d1ValueViaFFIToJSVal :: D1ValueViaFFI -> IO JSVal
d1ValueViaFFIToJSVal D1NullViaFFI = jsNullValue
d1ValueViaFFIToJSVal (D1IntegerViaFFI integerValue)
    | integerValue >= -9007199254740991 && integerValue <= 9007199254740991 = jsDoubleToJSVal (fromInteger integerValue)
    | otherwise = fail "the D1 integer value is outside the JavaScript safe integer range"
d1ValueViaFFIToJSVal (D1RealViaFFI realValue) = jsDoubleToJSVal realValue
d1ValueViaFFIToJSVal (D1TextViaFFI textValue) = textToJSVal textValue
d1ValueViaFFIToJSVal (D1BlobViaFFI blobValue) = byteStringToJSByteArray blobValue

d1PrepareViaFFI :: JSVal -> Text -> IO JSVal
d1PrepareViaFFI databaseJSValue sql = do
    sqlJSValue <- textToJSVal sql
    outcome <- decodeEnveloped pure =<< jsD1Prepare databaseJSValue sqlJSValue
    either (throwIO . userError . Text.unpack) pure outcome

d1BindViaFFI :: JSVal -> [D1ValueViaFFI] -> IO JSVal
d1BindViaFFI preparedStatementJSVal values = do
    valuesArrayJSVal <- jsEmptyArray
    for_ values (jsArrayPush valuesArrayJSVal <=< d1ValueViaFFIToJSVal)
    outcome <- decodeEnveloped pure =<< jsD1Bind preparedStatementJSVal valuesArrayJSVal
    either (throwIO . userError . Text.unpack) pure outcome

readRow :: JSVal -> IO [(Text, D1ValueViaFFI)]
readRow rowJSValue = do
    columnNamesJSValue <- jsObjectKeys rowJSValue
    columnCount <- jsArrayLength columnNamesJSValue
    forM [0 .. columnCount - 1] $ \index -> do
        columnNameJSvalue <- jsArrayIndex columnNamesJSValue index
        columnName <- jsValToText columnNameJSvalue
        columnValueJSValue <- jsObjectGet rowJSValue columnNameJSvalue
        columnValue <- jsD1ValueFromJSVal columnValueJSValue
        pure (columnName, columnValue)

jsD1ValueFromJSVal :: JSVal -> IO D1ValueViaFFI
jsD1ValueFromJSVal valueJSValue = do
    isNull <- jsIsNull valueJSValue
    if isNull
        then pure D1NullViaFFI
        else do
            isString <- jsIsString valueJSValue
            if isString
                then D1TextViaFFI <$> jsValToText valueJSValue
                else do
                    isNumber <- jsIsNumber valueJSValue
                    if isNumber
                        then do
                            isIntegerNumber <- jsIsIntegerNumber valueJSValue
                            doubleValue <- jsDoubleFromJSVal valueJSValue
                            pure (if isIntegerNumber then D1IntegerViaFFI (round doubleValue) else D1RealViaFFI doubleValue)
                        else do
                            byteArrayJSValue <- jsWrapArrayBufferAsUint8Array valueJSValue
                            D1BlobViaFFI <$> jsByteArrayToByteString byteArrayJSValue

decodeD1Meta :: JSVal -> IO D1MetaViaFFI
decodeD1Meta metaJSValue = do
    duration <- jsD1MetaDurationField metaJSValue
    changes <- readOptionalIntField metaJSValue jsD1MetaHasChanges jsD1MetaChangesField
    lastRowId <- readOptionalIntegerField metaJSValue jsD1MetaHasLastRowId jsD1MetaLastRowIdField
    rowsRead <- readOptionalIntegerField metaJSValue jsD1MetaHasRowsRead jsD1MetaRowsReadField
    rowsWritten <- readOptionalIntegerField metaJSValue jsD1MetaHasRowsWritten jsD1MetaRowsWrittenField
    pure (duration, changes, lastRowId, rowsRead, rowsWritten)
  where
    readOptionalIntField objectJSValue hasField readField = do
        present <- hasField objectJSValue
        if present then Just <$> readField objectJSValue else pure Nothing
    readOptionalIntegerField objectJSValue hasField readField = do
        present <- hasField objectJSValue
        if present then Just . round <$> readField objectJSValue else pure Nothing

d1AllViaFFI :: JSVal -> IO (Either Text ([[(Text, D1ValueViaFFI)]], Bool, D1MetaViaFFI))
d1AllViaFFI preparedStatementJSVal = decodeEnveloped decodeAllResult =<< jsD1AllEnveloped preparedStatementJSVal
  where
    decodeAllResult resultJSValue = do
        resultsArrayJSValue <- jsD1ResultResultsField resultJSValue
        rowCount <- jsArrayLength resultsArrayJSValue
        rows <- forM [0 .. rowCount - 1] (readRow <=< jsArrayIndex resultsArrayJSValue)
        success <- jsD1ResultSuccessField resultJSValue
        metaJSValue <- jsD1ResultMetaField resultJSValue
        meta <- decodeD1Meta metaJSValue
        pure (rows, success, meta)

d1FirstViaFFI :: JSVal -> IO (Either Text (Maybe [(Text, D1ValueViaFFI)]))
d1FirstViaFFI preparedStatementJSVal = decodeEnveloped decodeFirstResult =<< jsD1FirstEnveloped preparedStatementJSVal
  where
    decodeFirstResult rowJSValue = do
        isNull <- jsIsNull rowJSValue
        if isNull then pure Nothing else Just <$> readRow rowJSValue

d1RunViaFFI :: JSVal -> IO (Either Text (Bool, D1MetaViaFFI))
d1RunViaFFI preparedStatementJSVal = decodeEnveloped decodeRunResult =<< jsD1RunEnveloped preparedStatementJSVal
  where
    decodeRunResult resultJSValue = do
        success <- jsD1ResultSuccessField resultJSValue
        metaJSValue <- jsD1ResultMetaField resultJSValue
        decodeD1Meta metaJSValue >>= \meta -> pure (success, meta)

d1BatchViaFFI :: JSVal -> [JSVal] -> IO (Either Text [(Bool, D1MetaViaFFI)])
d1BatchViaFFI databaseJSValue preparedStatementJSValues = do
    statementsArrayJSValue <- jsEmptyArray
    for_ preparedStatementJSValues (jsArrayPush statementsArrayJSValue)
    decodeEnveloped decodeBatchResults =<< jsD1BatchEnveloped databaseJSValue statementsArrayJSValue
  where
    decodeBatchResults resultsArrayJSValue = do
        resultCount <- jsArrayLength resultsArrayJSValue
        forM [0 .. resultCount - 1] (decodeOneResult <=< jsArrayIndex resultsArrayJSValue)
    decodeOneResult itemJSValue = do
        success <- jsD1ResultSuccessField itemJSValue
        metaJSValue <- jsD1ResultMetaField itemJSValue
        decodeD1Meta metaJSValue >>= \meta -> pure (success, meta)

d1ExecViaFFI :: JSVal -> Text -> IO (Either Text (Int, Double))
d1ExecViaFFI databaseJSValue sql = do
    sqlJSValue <- textToJSVal sql
    decodeEnveloped decodeExecResult =<< jsD1ExecEnveloped databaseJSValue sqlJSValue
  where
    decodeExecResult resultJSValue = do
        count <- jsD1ExecCountField resultJSValue
        duration <- jsD1ExecDurationField resultJSValue
        pure (count, duration)

-- Native prepare/bind are synchronous. Catch here: a JS throw from an unsafe
-- import bypasses the Haskell exception boundary and can terminate the request.
foreign import javascript unsafe
    """
    (() => {
      try { return {ok:true,value:$1.prepare($2)}; }
      catch (error) {
        try { return {ok:false,message:String(error)}; }
        catch { return {ok:false,message:'D1 prepare failed with an unprintable error'}; }
      }
    })()
    """
    jsD1Prepare :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      try { return {ok:true,value:$1.bind.apply($1, $2)}; }
      catch (error) {
        try { return {ok:false,message:String(error)}; }
        catch { return {ok:false,message:'D1 bind failed with an unprintable error'}; }
      }
    })()
    """
    jsD1Bind :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.all()
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsD1AllEnveloped :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.first()
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsD1FirstEnveloped :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.run()
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsD1RunEnveloped :: JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.batch($2)
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsD1BatchEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript safe
    """
    (async () => {
      try {
        return {
          ok: true,
          value: await $1.exec($2)
        };
      } catch (error) {
        try {
          return {
            ok: false,
            message: String(error)
          };
        } catch {
          return {
            ok: false,
            message: 'unstringifiable error'
          };
        }
      }
    })()
    """
    jsD1ExecEnveloped :: JSVal -> JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const statementCount = $1.count;
      if (!Number.isSafeInteger(statementCount) || statementCount < 0 || statementCount > 2147483647) {
        throw new TypeError('the D1 exec statement count is not a non-negative 32-bit integer: ' + typeof statementCount);
      }
      return statementCount;
    })()
    """
    jsD1ExecCountField :: JSVal -> IO Int

foreign import javascript unsafe
    """
    (() => {
      const durationMillis = $1.duration;
      if (!Number.isFinite(durationMillis)) {
        throw new TypeError('the D1 exec duration field is not a finite number: ' + typeof durationMillis);
      }
      return durationMillis;
    })()
    """
    jsD1ExecDurationField :: JSVal -> IO Double

foreign import javascript unsafe "$1.results"
    jsD1ResultResultsField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const successFlag = $1.success;
      if (successFlag === true) {
        return true;
      }
      if (successFlag === false) {
        return false;
      }
      throw new TypeError('the D1 result success field is not a boolean: ' + typeof successFlag);
    })()
    """
    jsD1ResultSuccessField :: JSVal -> IO Bool

foreign import javascript unsafe "$1.meta"
    jsD1ResultMetaField :: JSVal -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const durationMillis = $1.duration;
      if (!Number.isFinite(durationMillis)) {
        throw new TypeError('the D1 meta duration field is not a finite number: ' + typeof durationMillis);
      }
      return durationMillis;
    })()
    """
    jsD1MetaDurationField :: JSVal -> IO Double

foreign import javascript unsafe "Number.isSafeInteger($1.changes)"
    jsD1MetaHasChanges :: JSVal -> IO Bool

foreign import javascript unsafe
    """
    (() => {
      const changedRowCount = $1.changes;
      if (!Number.isSafeInteger(changedRowCount) || changedRowCount < 0 || changedRowCount > 2147483647) {
        throw new TypeError('the D1 meta changes field is not a non-negative 32-bit integer: ' + typeof changedRowCount);
      }
      return changedRowCount;
    })()
    """
    jsD1MetaChangesField :: JSVal -> IO Int

foreign import javascript unsafe "Number.isFinite($1.last_row_id)"
    jsD1MetaHasLastRowId :: JSVal -> IO Bool

foreign import javascript unsafe
    """
    (() => {
      const lastRowIdentifier = $1.last_row_id;
      if (!Number.isFinite(lastRowIdentifier)) {
        throw new TypeError('the D1 meta last_row_id field is not a finite number: ' + typeof lastRowIdentifier);
      }
      return lastRowIdentifier;
    })()
    """
    jsD1MetaLastRowIdField :: JSVal -> IO Double

foreign import javascript unsafe "Number.isFinite($1.rows_read)"
    jsD1MetaHasRowsRead :: JSVal -> IO Bool

foreign import javascript unsafe
    """
    (() => {
      const rowsReadCount = $1.rows_read;
      if (!Number.isFinite(rowsReadCount)) {
        throw new TypeError('the D1 meta rows_read field is not a finite number: ' + typeof rowsReadCount);
      }
      return rowsReadCount;
    })()
    """
    jsD1MetaRowsReadField :: JSVal -> IO Double

foreign import javascript unsafe "Number.isFinite($1.rows_written)"
    jsD1MetaHasRowsWritten :: JSVal -> IO Bool

foreign import javascript unsafe
    """
    (() => {
      const rowsWrittenCount = $1.rows_written;
      if (!Number.isFinite(rowsWrittenCount)) {
        throw new TypeError('the D1 meta rows_written field is not a finite number: ' + typeof rowsWrittenCount);
      }
      return rowsWrittenCount;
    })()
    """
    jsD1MetaRowsWrittenField :: JSVal -> IO Double

foreign import javascript unsafe "null"
    jsNullValue :: IO JSVal

foreign import javascript unsafe "$1 === null"
    jsIsNull :: JSVal -> IO Bool

foreign import javascript unsafe "typeof $1 === 'string'"
    jsIsString :: JSVal -> IO Bool

foreign import javascript unsafe "typeof $1 === 'number'"
    jsIsNumber :: JSVal -> IO Bool

foreign import javascript unsafe "Number.isInteger($1)"
    jsIsIntegerNumber :: JSVal -> IO Bool

foreign import javascript unsafe "$1"
    jsDoubleToJSVal :: Double -> IO JSVal

foreign import javascript unsafe
    """
    (() => {
      const numberValue = $1;
      if (typeof numberValue !== 'number') {
        throw new TypeError('the D1 column value is not a JS number: ' + typeof numberValue);
      }
      return numberValue;
    })()
    """
    jsDoubleFromJSVal :: JSVal -> IO Double

foreign import javascript unsafe "new Uint8Array($1)"
    jsWrapArrayBufferAsUint8Array :: JSVal -> IO JSVal

foreign import javascript unsafe "[]"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push($2)"
    jsArrayPush :: JSVal -> JSVal -> IO ()

foreign import javascript unsafe
    """
    (() => {
      const sourceArray = $1;
      if (!Array.isArray(sourceArray)) {
        throw new TypeError('the D1 array this decoder was handed is not a JS Array: ' + typeof sourceArray);
      }
      const elementCount = sourceArray.length;
      if (!Number.isSafeInteger(elementCount) || elementCount < 0 || elementCount > 2147483647) {
        throw new RangeError('the D1 array this decoder was handed has a length no 32-bit Haskell Int can carry');
      }
      return elementCount;
    })()
    """
    jsArrayLength :: JSVal -> IO Int

foreign import javascript unsafe "$1[$2]"
    jsArrayIndex :: JSVal -> Int -> IO JSVal

foreign import javascript unsafe "Object.keys($1)"
    jsObjectKeys :: JSVal -> IO JSVal

foreign import javascript unsafe "$1[$2]"
    jsObjectGet :: JSVal -> JSVal -> IO JSVal

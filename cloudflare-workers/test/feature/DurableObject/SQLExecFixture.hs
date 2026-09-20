module DurableObject.SQLExecFixture (sqlExecChecks) where

import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Binding.DurableObject.SQL
import Control.Exception (try)
import Control.Monad (unless, void)
import Data.ByteString qualified as Bytes
import GHC.Wasm.Prim (JSVal)

sqlExecChecks :: DurableObjectStorage -> IO ()
sqlExecChecks storage@(DurableObjectStorage native) = do
    direct <- DurableObjectStorage <$> withoutTransactionSync native
    let values = [SQLNull, SQLNumber 1.25, SQLText "'; DROP TABLE direct_sql; --", SQLBlob (Bytes.pack [0, 128, 255])]
    typed <- sqlExec direct sqlDefaultLimits (SQLStatement "SELECT ?, ?, ?, ?" values)
    unless (rows typed == [values]) (fail "Direct SQL value round-trip failed")
    void $ sqlExec storage sqlDefaultLimits
        (SQLStatement "CREATE TABLE IF NOT EXISTS direct_sql (value INTEGER)" [])
    void $ sqlExec storage sqlDefaultLimits (SQLStatement "DELETE FROM direct_sql" [])
    let insertReturning = SQLStatement "INSERT INTO direct_sql VALUES (1) RETURNING value" []
        limited = sqlDefaultLimits{maximumRows = 0}
        expectFailure action = do
            result <- try @SQLError action
            case result of
                Left _ -> pure ()
                Right _ -> fail "Expected SQL output limit failure"
        checkCount = do
            result <- sqlExec storage sqlDefaultLimits (SQLStatement "SELECT COUNT(*) FROM direct_sql" [])
            unless (rows result == [[SQLNumber 1]]) (fail "Unexpected SQL rollback semantics")
    -- Direct execution has no extra transaction. A serialization failure after
    -- native INSERT is not an automatic rollback of that INSERT.
    expectFailure (sqlExec storage limited insertReturning)
    checkCount
    expectFailure $ doStorageTransactionWith storage (sqlExec storage limited insertReturning)
    checkCount
    -- The pre-existing API keeps its transactionSync rollback behavior.
    expectFailure (sqlExecute storage limited insertReturning)
    checkCount

foreign import javascript unsafe
    """
    ({
      sql: $1.sql,
      transactionSync() {
        throw new Error('sqlExec must not introduce transactionSync');
      }
    })
    """
    withoutTransactionSync :: JSVal -> IO JSVal

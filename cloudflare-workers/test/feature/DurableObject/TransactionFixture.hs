module DurableObject.TransactionFixture (transactionChecks) where

import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.Binding.DurableObject.SQL
import Control.Concurrent
import Control.Exception
import Control.Monad (replicateM, unless, void)
import Data.Aeson (Value, object, (.=))
import Data.List (sort)
import Data.Maybe (isNothing)
import Data.Text (Text)
import DurableObject.TransactionLifecycle (lifecycleChecks)
import DurableObject.SQLExecFixture (sqlExecChecks)
import DurableObject.Wait (pause)

data Rejected = Rejected Int Text deriving stock (Show, Eq)
instance Exception Rejected

-- Exercises public library functions against real SQLite-backed DO storage.
transactionChecks :: DurableObjectStorage -> IO Value
transactionChecks storage = do
    void $ execute "CREATE TABLE IF NOT EXISTS native_tx (identifier INTEGER PRIMARY KEY, value INTEGER)"
    void $ execute "INSERT OR REPLACE INTO native_tx VALUES (1, 0)"
    doStorageDeleteAlarm storage
    emptyAlarm <- doStorageGetAlarm storage
    check "initial alarm" (isNothing emptyAlarm)
    let increment = do
            current <- readValue
            pause 1
            writeValue (current + 1)
            observed <- readValue
            check "read own writes" (observed == current + 1)
            doStorageSetAlarm storage (1900000000000 + round observed)
            pure observed
        rejected = do
            void increment
            throwIO (Rejected 17 "original payload")
        run :: IO a -> IO a
        run = doStorageTransactionWith storage
    absent <- try @Rejected (run rejected :: IO ())
    alarmAfterAbort <- doStorageGetAlarm storage
    check "abort leaves alarm absent"
        (absent == Left (Rejected 17 "original payload") && isNothing alarmAfterAbort)
    committed <- run increment
    check "commit" (committed == 1)
    rejectedResult <- try @Rejected (run rejected :: IO ())
    check "exception type and payload" (rejectedResult == Left (Rejected 17 "original payload"))
    unchanged <- readValue
    alarmAfterSet <- doStorageGetAlarm storage
    check "SQL and alarm rollback" (unchanged == 1 && alarmAfterSet == Just 1900000000001)
    sqlFailure <- try @SQLError $ run $ do
        void increment
        void $ execute "INSERT INTO native_tx VALUES (1, 99)"
    check "SQL exception" (case sqlFailure of Left _ -> True; _ -> False)
    afterSQL <- readValue
    check "SQL exception rollback" (afterSQL == 1)
    void $ try @Rejected $ run $ do
        doStorageDeleteAlarm storage
        throwIO (Rejected 0 "delete")
    restored <- doStorageGetAlarm storage
    check "delete alarm rollback" (restored == Just 1900000000001)
    leftResult <- run (Left <$> increment :: IO (Either Double ()))
    check "Left is an ordinary result" (leftResult == Left 2)
    caught <- run $ do
        value <- increment
        void $ try @SQLError $ execute "INSERT INTO native_tx VALUES (1, 99)"
        pure value
    check "caught SQL exception does not invent an abort policy" (caught == 3)
    slots <- replicateM 8 newEmptyMVar
    mapM_ (\slot -> void $ forkIO $ try @SomeException (run increment) >>= putMVar slot) slots
    concurrent <- traverse takeMVar slots >>= traverse (either throwIO pure)
    check "concurrent read/modify/write" (sort concurrent == [4 .. 11])
    entered <- newEmptyMVar
    blocked <- newEmptyMVar
    completed <- newEmptyMVar
    thread <- forkIO $ do
        result <- try @SomeException $ run $ do
            void increment
            putMVar entered ()
            takeMVar blocked
        putMVar completed result
    takeMVar entered
    killThread thread
    cancelled <- takeMVar completed
    check "cancel preserves ThreadKilled" (case cancelled of
        Left exception -> fromException exception == Just ThreadKilled
        _ -> False)
    afterCancel <- readValue
    check "cancel rolls back" (afterCancel == 11)
    mapM_ (\_ -> run (pure ())) [1 .. 100 :: Int]
    run (doStorageDeleteAlarm storage)
    deleted <- doStorageGetAlarm storage
    check "delete alarm commits" (isNothing deleted)
    sqlExecChecks storage
    lifecycle <- lifecycleChecks
    pure $ object
        [ "commit" .= True, "rollback" .= True, "alarm" .= True
        , "exceptions" .= True, "leftCommits" .= True, "caughtErrorCommits" .= True
        , "concurrency" .= True, "cancellation" .= True, "repetition" .= True
        , "lifecycle" .= lifecycle, "directSQL" .= True
        ]
  where
    execute query = sqlExec storage sqlDefaultLimits (SQLStatement query [])
    readValue = do
        result <- execute "SELECT value FROM native_tx WHERE identifier = 1"
        case rows result of
            [[SQLNumber value]] -> pure value
            _ -> fail "Unexpected transaction fixture rows"
    writeValue value = void $ sqlExec storage sqlDefaultLimits
        (SQLStatement "UPDATE native_tx SET value = ? WHERE identifier = 1" [SQLNumber value])

check :: String -> Bool -> IO ()
check label condition = unless condition (fail ("Transaction check failed: " ++ label))

module Cloudflare.Workers.Binding.DurableObject (
    DurableObjectStub (..),
    DurableObjectID (..),
    DurableObjectNamespace (..),
    DurableObjectValue (..),
    DurableObjectError (..),
    DurableObjectTransactionError,
    transactionFailureMessage,
    DurableObjectStorage (..),
    DurableObjectStorageOperation (..),
    doIDFromName,
    doNewUniqueID,
    doIDFromString,
    doIDToString,
    doGet,
    doGetByName,
    doFetch,
    doCall,
    doStorageGet,
    doStoragePut,
    doStorageDelete,
    doStorageList,
    doStorageTransaction,
    doStorageTransactionWith,
    doStorageGetAlarm,
    doStorageSetAlarm,
    doStorageDeleteAlarm,
) where

import Data.Text (Text)
import Cloudflare.Workers.Internal.FFI.DurableObject.Transaction
    (DurableObjectTransactionError, transactionFailureMessage, doStorageTransactionWithViaFFI)

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Internal.FFI.DurableObject
    ( doStorageGetAlarmViaFFI, doStorageSetAlarmViaFFI, doStorageDeleteAlarmViaFFI
    , doCallViaFFI, doFetchViaFFI, doGetByNameViaFFI, doGetViaFFI
    , doIdFromNameViaFFI, doIdToStringViaFFI, doIdFromStringViaFFI
    , doNewUniqueIdViaFFI, doStorageDeleteViaFFI, doStorageGetViaFFI
    , doStorageListViaFFI, doStoragePutViaFFI, doStorageTransactionViaFFI
    )
import Control.Exception (Exception, throwIO)
import Data.ByteString (ByteString)
import GHC.Wasm.Prim (JSVal)

newtype DurableObjectStub = DurableObjectStub JSVal

newtype DurableObjectID = DurableObjectID JSVal

newtype DurableObjectNamespace = DurableObjectNamespace JSVal

newtype DurableObjectValue = DurableObjectValue JSVal

newtype DurableObjectStorage = DurableObjectStorage JSVal

data DOJurisdiction
    = DOJurisdictionEU
    | DOJurisdictionUS
    | DOJurisdictionFedRAMP
    deriving stock (Show, Eq, Ord, Enum, Bounded)

data DurableObjectError
    = DurableObjectInvalidIDString Text
    | DurableObjectIDSerializationFailed Text
    | DurableObjectFetchFailed Text
    | DurableObjectRPCFailed Text
    | DurableObjectStorageFailed Text
    deriving stock (Show, Eq)

instance Exception DurableObjectError

data DurableObjectStorageOperation
    = DurableObjectStorageOperationPut Text ByteString
    | DurableObjectStorageOperationDelete Text
    | DurableObjectStorageOperationFail
    deriving stock (Show, Eq)

doIDFromName :: DurableObjectNamespace -> Text -> IO DurableObjectID
doIDFromName (DurableObjectNamespace namespaceJSVal) name = DurableObjectID <$> doIdFromNameViaFFI namespaceJSVal name

doNewUniqueID :: DurableObjectNamespace -> IO DurableObjectID
doNewUniqueID (DurableObjectNamespace namespaceJSVal) = DurableObjectID <$> doNewUniqueIdViaFFI namespaceJSVal

doIDFromString :: DurableObjectNamespace -> Text -> IO (Either DurableObjectError DurableObjectID)
doIDFromString (DurableObjectNamespace namespaceJSVal) hexID = do
    outcome <- doIdFromStringViaFFI namespaceJSVal hexID
    pure (either (Left . DurableObjectInvalidIDString) (Right . DurableObjectID) outcome)

-- | Serialize an identifier for storage and later restoration in the same namespace.
-- Throws 'DurableObjectIDSerializationFailed' if the native operation fails or
-- returns a value other than the documented 64-digit hexadecimal string.
doIDToString :: DurableObjectID -> IO Text
doIDToString (DurableObjectID identifier) = do
    outcome <- doIdToStringViaFFI identifier
    either (throwIO . DurableObjectIDSerializationFailed) pure outcome

doGet :: DurableObjectNamespace -> DurableObjectID -> IO DurableObjectStub
doGet (DurableObjectNamespace namespaceJSVal) (DurableObjectID idJSVal) = DurableObjectStub <$> doGetViaFFI namespaceJSVal idJSVal

doGetByName :: DurableObjectNamespace -> Text -> IO DurableObjectStub
doGetByName (DurableObjectNamespace namespaceJSVal) name = DurableObjectStub <$> doGetByNameViaFFI namespaceJSVal name

doFetch :: DurableObjectStub -> Request -> IO Response
doFetch (DurableObjectStub stubJSVal) request = do
    outcome <- doFetchViaFFI stubJSVal request
    either (throwIO . DurableObjectFetchFailed) pure outcome

doCall :: DurableObjectStub -> Text -> [DurableObjectValue] -> IO (Either DurableObjectError DurableObjectValue)
doCall (DurableObjectStub stubJSVal) methodName args = do
    outcome <- doCallViaFFI stubJSVal methodName (map unwrapDurableObjectValue args)
    pure (either (Left . DurableObjectRPCFailed) (Right . DurableObjectValue) outcome)
  where
    unwrapDurableObjectValue (DurableObjectValue argJSVal) = argJSVal

doStorageGet :: DurableObjectStorage -> Text -> IO (Maybe ByteString)
doStorageGet (DurableObjectStorage storageJSVal) key = do
    outcome <- doStorageGetViaFFI storageJSVal key
    either (throwIO . DurableObjectStorageFailed) pure outcome

doStoragePut :: DurableObjectStorage -> Text -> ByteString -> IO ()
doStoragePut (DurableObjectStorage storageJSVal) key value = do
    outcome <- doStoragePutViaFFI storageJSVal key value
    either (throwIO . DurableObjectStorageFailed) pure outcome

doStorageDelete :: DurableObjectStorage -> Text -> IO Bool
doStorageDelete (DurableObjectStorage storageJSVal) key = do
    outcome <- doStorageDeleteViaFFI storageJSVal key
    either (throwIO . DurableObjectStorageFailed) pure outcome

doStorageList :: DurableObjectStorage -> Maybe Text -> Bool -> Maybe Int -> IO [(Text, ByteString)]
doStorageList (DurableObjectStorage storageJSVal) maybePrefix reverseOrder maybeLimit = do
    outcome <- doStorageListViaFFI storageJSVal maybePrefix reverseOrder maybeLimit
    either (throwIO . DurableObjectStorageFailed) pure outcome

doStorageTransaction :: DurableObjectStorage -> [DurableObjectStorageOperation] -> IO (Either DurableObjectError ())
doStorageTransaction (DurableObjectStorage storageJSVal) operations = do
    outcome <- doStorageTransactionViaFFI storageJSVal (map toWireOperation operations)
    pure (either (Left . DurableObjectStorageFailed) Right outcome)
  where
    toWireOperation :: DurableObjectStorageOperation -> (Text, Maybe Text, Maybe ByteString)
    toWireOperation (DurableObjectStorageOperationPut key value) = ("put", Just key, Just value)
    toWireOperation (DurableObjectStorageOperationDelete key) = ("delete", Just key, Nothing)
    toWireOperation DurableObjectStorageOperationFail = ("fail", Nothing, Nothing)

-- | Run a Haskell callback inside the native SQLite-backed storage transaction.
-- Use this same storage for SQL, KV and Alarm operations in the callback.
-- A normal return (including 'Left') commits; an escaping Haskell exception
-- rejects the native callback and is rethrown unchanged after rollback.
-- Native transaction failures throw 'DurableObjectTransactionError'.
--
-- KV-backed storage is unsupported: its retryable callback/txn object contract
-- differs from SQLite storage. The callback result is not deeply evaluated.
-- Await all asynchronous operations inside the callback; do not fork storage
-- operations that outlive it. This function does not roll back external I/O.
--
-- Cancellation during the callback rejects it. Cancellation while waiting for
-- settlement waits for native settlement before releasing FFI references; it
-- cannot undo a commit already requested. Cleanup can therefore block until
-- Cloudflare settles the transaction. No timeout or retry policy is added.
doStorageTransactionWith :: DurableObjectStorage -> IO a -> IO a
doStorageTransactionWith (DurableObjectStorage storage) =
    doStorageTransactionWithViaFFI storage

-- | Read the scheduled Unix timestamp in milliseconds, or 'Nothing'.
-- Uses the platform's default getAlarm options.
doStorageGetAlarm :: DurableObjectStorage -> IO (Maybe Integer)
doStorageGetAlarm (DurableObjectStorage storage) =
    doStorageGetAlarmViaFFI storage >>= either (throwIO . DurableObjectStorageFailed) pure

-- | Schedule an alarm at an absolute Unix timestamp in milliseconds.
doStorageSetAlarm :: DurableObjectStorage -> Integer -> IO ()
doStorageSetAlarm (DurableObjectStorage storage) timestamp =
    doStorageSetAlarmViaFFI storage timestamp >>= either (throwIO . DurableObjectStorageFailed) pure

doStorageDeleteAlarm :: DurableObjectStorage -> IO ()
doStorageDeleteAlarm (DurableObjectStorage storage) =
    doStorageDeleteAlarmViaFFI storage >>= either (throwIO . DurableObjectStorageFailed) pure

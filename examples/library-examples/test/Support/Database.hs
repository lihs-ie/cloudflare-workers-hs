module Support.Database (databaseFailureRecovery) where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query
import ExampleSupport.Interop (textToJSVal)
import Control.Exception (try, finally)
import Control.Monad (void)
import Data.Aeson (object, encode, (.=))
import Data.ByteString.Lazy qualified as Lazy
import Data.Text.Encoding (decodeUtf8)
import GHC.Wasm.Prim (JSVal)

databaseFailureRecovery :: JSVal -> IO JSVal
databaseFailureRecovery raw = do
    let database = D1 raw
    void $ d1Exec database "CREATE TABLE IF NOT EXISTS fixture_d1_failures (value INTEGER NOT NULL CHECK(value>=0))"
    (do
        syntax <- try @D1ExecutionError $ d1Query database (D1Statement "SELECT FROM fixture_d1_failures" []) d1RawRow
        constraint <- try @D1ExecutionError $ d1Execute database (D1Statement "INSERT INTO fixture_d1_failures VALUES (?)" [D1Integer (-1)])
        void $ d1Execute database (D1Statement "INSERT INTO fixture_d1_failures VALUES (?)" [D1Integer 7])
        recovered <- d1QueryFirst database (D1Statement "SELECT value FROM fixture_d1_failures" []) (d1Column "value" d1Integer)
        let failed (Left _) = True
            failed (Right _) = False
        textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ object
            [ "syntaxRejected" .= failed syntax
            , "constraintRejected" .= failed constraint
            , "recovered" .= recovered
            ]) `finally` void (d1Exec database "DROP TABLE fixture_d1_failures")

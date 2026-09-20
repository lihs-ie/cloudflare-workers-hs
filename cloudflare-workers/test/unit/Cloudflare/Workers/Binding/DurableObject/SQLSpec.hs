module Cloudflare.Workers.Binding.DurableObject.SQLSpec (spec) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectStorage (..))
import Cloudflare.Workers.Binding.DurableObject.SQL
import Cloudflare.Workers.HostTestKit (phantomJSVal)
import Control.Exception (try)
import Control.Monad (forM_)
import Data.ByteString qualified as Bytes
import Data.Text qualified as Text
import Test.Syd

spec :: Spec
spec = describe "sqlExec validates before entering JSFFI" $ do
    let storage = DurableObjectStorage phantomJSVal
        statement = SQLStatement "SELECT 1" []
    forM_
        [ sqlDefaultLimits{maximumRows = -1}
        , sqlDefaultLimits{maximumRows = 10001}
        , sqlDefaultLimits{maximumBytes = 0}
        , sqlDefaultLimits{maximumBytes = 16777217}
        , sqlDefaultLimits{maximumStatements = 0}
        , sqlDefaultLimits{maximumStatements = 129}
        ] $ \limits ->
            it ("rejects invalid limits: " ++ show limits) $ do
                result <- try @SQLError (sqlExec storage limits statement)
                result `shouldBe` Left (SQLError "Invalid SQL result limits")
    forM_
        [ SQLStatement " " []
        , SQLStatement (Text.replicate 65537 "x") []
        , SQLStatement "SELECT ?" (replicate 101 SQLNull)
        , SQLStatement "SELECT ?" [SQLNumber (0 / 0)]
        , SQLStatement "SELECT ?" [SQLNumber (1 / 0)]
        , SQLStatement "SELECT ?" [SQLNumber 9007199254740992]
        ] $ \invalid ->
            it ("rejects invalid statement of length " ++ show (Text.length (sql invalid))
                ++ " with " ++ show (length (parameters invalid)) ++ " parameters") $ do
                result <- try @SQLError (sqlExec storage sqlDefaultLimits invalid)
                result `shouldBe` Left (SQLError "Invalid SQL statement or parameter")
    it "bounds serialized input before touching the storage" $ do
        result <- try @SQLError $ sqlExec storage sqlDefaultLimits{maximumBytes = 256}
            (SQLStatement "SELECT ?" [SQLBlob (Bytes.replicate 1024 0)])
        result `shouldBe` Left (SQLError "SQL input exceeds byte limit")

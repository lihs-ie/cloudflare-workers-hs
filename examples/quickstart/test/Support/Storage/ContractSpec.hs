{-# LANGUAGE DeriveGeneric #-}
module Support.Storage.ContractSpec (spec) where

import Control.Exception (IOException, SomeException, try, displayException, fromException)
import Data.Maybe (isNothing)
import Data.Aeson (Value(..), ToJSON(..), eitherDecode, encode, object, (.=), genericToJSON, defaultOptions, Options(..))
import GHC.Generics (Generic)
import Data.ByteString.Lazy qualified as Bytes
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Text
import Data.IORef
import Data.List (isInfixOf, nub)
import Support.Storage.Model (Operation(..), expected)
import Support.Storage.Runtime (runOperationsWith)
import System.Exit (ExitCode(..))
import Test.Syd

spec :: Spec
spec = describe "storage model host contract" $ do
    it "preserves replay operation identity in batches and diagnostic output" $ do
        let put = Put "a" [0,255]
            changed = Put "a" [1]
            commands = [put, Get "a", Delete "a", Transaction "a" []]
        put /= changed `shouldBe` True
        nub [put, put, changed] `shouldBe` [put, changed]
        mapM_ (\(command, rendered) -> do
            show command `shouldBe` rendered
            showsPrec 11 command "suffix" `shouldBe` "(" <> rendered <> ")suffix")
            [(put, "Put \"a\" [0,255]"), (Get "a", "Get \"a\""), (Delete "a", "Delete \"a\""), (Transaction "a" [], "Transaction \"a\" []")]
        showList commands "suffix" `shouldBe` "[Put \"a\" [0,255],Get \"a\",Delete \"a\",Transaction \"a\" []]suffix"
        toJSON commands `shouldBe` toJSON (map toJSON commands)
        toJSON (OperationEnvelope put) `shouldBe` object ["operation" .= toJSON put]
        eitherDecode (encode commands) `shouldBe` Right (map toJSON commands)

    it "preserves empty binary values, Unicode keys, overwrite and missing deletion" $ do
        expected [] `shouldBe` []
        expected [Get "日本語", Put "日本語" [], Get "日本語", Transaction "日本語" [255], Get "日本語", Delete "日本語", Delete "日本語", Get "日本語"]
            `shouldBe` [Null, Null, toJSON ([] :: [Int]), Null, toJSON ([255] :: [Int]), Bool True, Bool False, Null]
    it "encodes each operation and invokes the selected bridge with exact stdin" $ do
        let commands = [Put "日本語" [0,255], Get "日本語", Transaction "b" [], Delete "b"]
            runner program arguments input = do
                program `shouldBe` "node"
                arguments `shouldBe` ["selected-bridge.mjs"]
                eitherDecode (Bytes.fromStrict (Text.encodeUtf8 (Text.pack input))) `shouldBe` Right (map toJSON commands)
                pure (ExitSuccess, "[null,[],true,false]", "ignored stderr")
        runOperationsWith "selected-bridge.mjs" runner commands `shouldReturn` [Null, toJSON ([] :: [Int]), Bool True, Bool False]
    it "rejects out-of-range put and transaction bytes before invoking the bridge" $ do
        invoked <- newIORef False
        let runner _ _ _ = writeIORef invoked True >> pure (ExitSuccess, "[]", "")
        mapM_ (\operation -> failureContains "between 0 and 255" (runOperationsWith "bridge" runner [operation]))
            [Put "a" [-1], Put "a" [256], Transaction "a" [-1], Transaction "a" [256]]
        readIORef invoked `shouldReturn` False
    it "reports process failure and stderr instead of decoding misleading stdout" $
        failureContains "Storage model bridge exited 7: worker failed"
            (runOperationsWith "bridge" (\_ _ _ -> pure (ExitFailure 7, "[]", "worker failed")) [])
    it "the reusable failure assertion rejects successful actions and mismatched diagnostics" $ do
        -- A false-positive assertion helper would hide regressions in every
        -- bridge validation test above. Exercise that helper as a consumer.
        successfulAction <- try @SomeException (failureContains "expected diagnostic" (pure []))
        either
            (\failure -> "Expected bridge contract failure" `isInfixOf` displayException failure)
            (const False)
            successfulAction `shouldBe` True
        wrongDiagnostic <- try @SomeException
            (failureContains "expected diagnostic" (ioError (userError "different diagnostic")))
        either
            (\failure -> isNothing (fromException failure :: Maybe IOException))
            (const False)
            wrongDiagnostic `shouldBe` True
    it "contains malformed and wrong-shaped JSON and allows a later successful run" $ do
        mapM_ (\output -> do
            outcome <- try @IOException (runOperationsWith "bridge" (\_ _ _ -> pure (ExitSuccess, output, "")) [])
            case outcome of
                Left _ -> pure ()
                Right _ -> expectationFailure "Invalid bridge output was accepted") ["{", "{}", "null"]
        runOperationsWith "bridge" (\_ _ _ -> pure (ExitSuccess, "[]", "")) [] `shouldReturn` []

failureContains :: String -> IO [Value] -> IO ()
failureContains fragment action = do
    outcome <- try @IOException action
    case outcome of
        Left failure -> (fragment `isInfixOf` displayException failure) `shouldBe` True
        Right _ -> expectationFailure "Expected bridge contract failure"

-- A replay container may omit optional fields, but an operation is required.
newtype OperationEnvelope = OperationEnvelope {operation :: Operation} deriving (Generic)
instance ToJSON OperationEnvelope where
    toJSON = genericToJSON defaultOptions {omitNothingFields = True}

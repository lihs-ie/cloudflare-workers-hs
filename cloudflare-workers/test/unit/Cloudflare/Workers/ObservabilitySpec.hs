module Cloudflare.Workers.ObservabilitySpec (spec) where
import Cloudflare.Workers.Observability
import Cloudflare.Workers.Reactor
import Cloudflare.Workers.HostTestKit
import Data.Aeson (toJSON, object, (.=), eitherDecodeStrict, eitherDecode, encode)
import Data.Text.Encoding qualified as TextEncoding
import Support.Cloudflare.Workers.ObservabilityContracts (observabilityContracts)
import Support.Cloudflare.Workers.Logging
import Data.IORef
import Control.Exception (try, throwIO, IOException)
import Data.Text (Text)
import Test.Syd
spec :: Spec
spec = do
  it "preserves public severity, diagnostic, equality and batch serialization contracts" observabilityContracts
  it "uses info and full sampling by default" $
    defaultLoggerConfig `shouldBe` LoggerConfig LogInfo 1
  it "filters below minimum and uses an exclusive sample boundary" $ do
    shouldEmitLog (LoggerConfig LogInfo 0.5) LogDebug 0 `shouldBe` False
    shouldEmitLog (LoggerConfig LogInfo 0.5) LogInfo 0.49 `shouldBe` True
    shouldEmitLog (LoggerConfig LogInfo 0.5) LogWarn 0.5 `shouldBe` False
    shouldEmitLog (LoggerConfig LogInfo 0) LogError 1 `shouldBe` True
    map isDeferrableLogLevel [LogDebug,LogInfo,LogWarn,LogError] `shouldBe` [True,True,True,False]
  it "serializes all levels" $
    map toJSON [LogDebug,LogInfo,LogWarn,LogError] `shouldBe` map toJSON (["debug","info","warn","error"] :: [String])
  it "omits absent optional fields" $
    toJSON (LogRecord LogInfo "req" Nothing Nothing Nothing Nothing Nothing Nothing "hello")
      `shouldBe` object ["level" .= ("info" :: String),"request_id" .= ("req" :: String),"message" .= ("hello" :: String)]
  it "serializes every present optional field" $
    toJSON (LogRecord LogError "req" (Just "ray") (Just "GET") (Just "/") (Just 500) (Just 12.5) (Just "failure") "failed")
      `shouldBe` object ["level" .= ("error" :: String),"request_id" .= ("req" :: String),"ray_id" .= ("ray" :: String),"method" .= ("GET" :: String),"path" .= ("/" :: String),"status" .= (500 :: Int),"duration_ms" .= (12.5 :: Double),"error_kind" .= ("failure" :: String),"message" .= ("failed" :: String)]
  it "encodes a batch of log records with optional fields preserved per record" $ do
    let started = LogRecord LogInfo "batch-request" Nothing (Just "GET") (Just "/batch") Nothing Nothing Nothing "started"
        failed = LogRecord LogError "batch-request" (Just "ray") (Just "GET") (Just "/batch") Nothing (Just 3) (Just "failure") "failed"
    eitherDecode (encode [started, failed]) `shouldBe` Right [toJSON started, toJSON failed]
  it "falls back exactly once when host context cannot register deferred work" $ do
    records <- newIORef []
    let record = LogRecord LogInfo "req" Nothing Nothing Nothing Nothing Nothing Nothing "hello"
    deferredSink (WorkersExecutionContext phantomJSVal) (\entry -> modifyIORef' records (++ [entry])) record
    readIORef records >>= (`shouldBe` [record])
  it "preserves deferrable levels when native registration is unavailable" $ do
    records <- newIORef []
    let makeRecord level = LogRecord level "req" Nothing Nothing Nothing Nothing Nothing Nothing "deferred fallback"
    mapM_ (deferredSinkExceptErrors (WorkersExecutionContext phantomJSVal)
      (\entry -> modifyIORef' records (++ [entry])) . makeRecord) [LogDebug, LogInfo, LogWarn]
    readIORef records >>= (`shouldBe` map makeRecord [LogDebug, LogInfo, LogWarn])
  it "emits errors immediately without evaluating the context" $ do
    records <- newIORef []
    let record = LogRecord LogError "req" Nothing Nothing Nothing Nothing Nothing Nothing "failed"
    deferredSinkExceptErrors (error "must not use context") (\entry -> modifyIORef' records (++ [entry])) record
    readIORef records >>= (`shouldBe` [record])

  sequential $ do
    it "suppresses unsampled records and always emits errors as JSON" $ do
      let hidden = LogRecord LogInfo "req" Nothing Nothing Nothing Nothing Nothing Nothing "hidden"
          visible = hidden {logRecordLevel = LogError, logRecordMessage = "error"}
      (result, output) <- captureStderr $ do
        emitLog (LoggerConfig LogInfo 0) hidden
        emitLog (LoggerConfig LogInfo 0) visible
      result `shouldBe` ()
      eitherDecodeStrict (TextEncoding.encodeUtf8 output) `shouldBe` Right (toJSON visible)
    it "writes tail log text with a newline" $ do
      (result, output) <- captureStderr (tailLog "tail record")
      result `shouldBe` ()
      output `shouldBe` "tail record\n"

    it "restores stderr after a captured action throws" $ do
      let exception = userError "captured failure"
      outcome <- try (captureStderr (throwIO exception :: IO ()))
      case (outcome :: Either IOException ((), Text)) of
        Left actual -> actual `shouldBe` exception
        Right _ -> expectationFailure "capture swallowed the action exception"
      (result, output) <- captureStderr (tailLog "after failure")
      result `shouldBe` ()
      output `shouldBe` "after failure\n"

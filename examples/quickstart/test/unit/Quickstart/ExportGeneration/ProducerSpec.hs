{-# LANGUAGE OverloadedStrings #-}
module Quickstart.ExportGeneration.ProducerSpec (spec) where

import Cloudflare.Workers.Streaming (StreamEmitOutcome(..), StreamProducerOutcome(..))
import Control.Exception (IOException, displayException, throwIO, try)
import Data.IORef
import Quickstart.ExportGeneration.Producer (headerBytes, produceCSV)
import Test.Syd

spec :: Spec
spec = describe "CSV producer cancellation protocol" $ do
  it "does not read a page after header cancellation" $ do
    writes <- newIORef []
    reads <- newIORef (0 :: Int)
    outcome <- produceCSV
      (\bytes -> modifyIORef' writes (<> [bytes]) >> pure StreamEmitCancelled)
      (\_ _ -> modifyIORef' reads (+ 1) >> pure [])
    outcome `shouldBe` StreamProducerCompleted
    readIORef writes >>= (`shouldBe` [headerBytes])
    readIORef reads >>= (`shouldBe` 0)
  it "does not advance after a rejected data page" $ do
    writes <- newIORef []
    reads <- newIORef []
    outcome <- produceCSV
      (\bytes -> do
        modifyIORef' writes (<> [bytes])
        count <- length <$> readIORef writes
        pure (if count == 1 then StreamEmitAccepted else StreamEmitCancelled))
      (\url day -> modifyIORef' reads (<> [(url, day)]) >> pure [("last", "day", "row\r\n")])
    outcome `shouldBe` StreamProducerCompleted
    readIORef writes >>= (`shouldBe` [headerBytes, "row\r\n"])
    readIORef reads >>= (`shouldBe` [("", "")])
  it "advances to the last accepted row before an empty page completes" $ do
    reads <- newIORef []
    outcome <- produceCSV (const (pure StreamEmitAccepted)) $ \url day -> do
      modifyIORef' reads (<> [(url, day)])
      pure (if url == "" then [("first", "one", "1\r\n"), ("last", "two", "2\r\n")] else [])
    outcome `shouldBe` StreamProducerCompleted
    readIORef reads >>= (`shouldBe` [("", ""), ("last", "two")])
  it "propagates a real page reader exception after the header" $ do
    writes <- newIORef []
    outcome <- try @IOException $ produceCSV
      (\bytes -> modifyIORef' writes (<> [bytes]) >> pure StreamEmitAccepted)
      (\_ _ -> throwIO (userError "snapshot read failed"))
    either displayException (const "unexpected completion") outcome `shouldBe` "user error (snapshot read failed)"
    readIORef writes >>= (`shouldBe` [headerBytes])

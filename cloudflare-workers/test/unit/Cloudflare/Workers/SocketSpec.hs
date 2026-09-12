module Cloudflare.Workers.SocketSpec (spec) where

import Cloudflare.Workers.Socket
import Control.Monad (forM_)
import Test.Syd

spec :: Spec
spec = do
  it "accepts both port boundaries without truncation" $ do
    fmap socketPortValue (createSocketPort 1) `shouldBe` Just 1
    fmap socketPortValue (createSocketPort 65535) `shouldBe` Just 65535
  it "rejects zero, negative and overflowing ports" $ do
    map createSocketPort [minBound, -1, 0, 65536, maxBound] `shouldBe` replicate 5 Nothing

  it "classifies connection failures case-insensitively and preserves the original message" $ do
    forM_ ["CONNECT failure", "network timeout", "DNS missing", "connection refused"] $ \message ->
      classifySocketError message `shouldBe` SocketError SocketConnectionError message
  it "classifies stream failures and preserves unknown failure information" $ do
    forM_ ["stream failed", "Readable unavailable", "WRITABLE locked"] $ \message ->
      classifySocketError message `shouldBe` SocketError SocketStreamError message
    classifySocketError "TLS negotiation failed" `shouldBe` SocketError SocketOtherError "TLS negotiation failed"
    classifySocketError "" `shouldBe` SocketError SocketOtherError ""
  it "allows TLS upgrade only on a ready starttls socket" $ do
    forM_ [SecureTransportOff, SecureTransportOn, SecureTransportStartTls] $ \transport ->
      forM_ [SocketReady, SocketStartTlsConsumed, SocketClosed] $ \state ->
        socketCanStartTls transport state `shouldBe` (transport == SecureTransportStartTls && state == SocketReady)

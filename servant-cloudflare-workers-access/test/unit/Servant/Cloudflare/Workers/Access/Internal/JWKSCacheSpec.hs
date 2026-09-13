module Servant.Cloudflare.Workers.Access.Internal.JWKSCacheSpec (spec) where

import Control.Concurrent (forkIO, killThread)
import Control.Concurrent.MVar
import Control.Exception (bracket_, finally)
import Data.IORef
import Servant.Cloudflare.Workers.Access.Internal.JWKS
import Servant.Cloudflare.Workers.Access.Internal.JWKSCache
import Support.Runtime.JWKSCache (runJWKSCacheScenarios)
import Support.Fixtures.Claims
import Test.Syd

spec :: Spec
spec = sequential $ describe "JWKS cache" $ do
    it "satisfies the shared host and WASM contracts" $ do
        scenarios <- runJWKSCacheScenarios
        length scenarios `shouldBe` 11
    it "reuses fresh entries, expires at TTL and isolates URLs" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        calls <- newIORef (0 :: Int)
        let fetch = modifyIORef' calls (+ 1) >> pure (Right (JWKSDocument [key "known"]))
            lookupAt time url = lookupOrFetchJWKWith fetch (pure time) 300 url "known"
        lookupAt 1000 "url" `shouldReturn` Right (key "known")
        lookupAt 1299 "url" `shouldReturn` Right (key "known")
        readIORef calls `shouldReturn` 1
        lookupAt 1300 "url" `shouldReturn` Right (key "known")
        lookupAt 1301 "other-url" `shouldReturn` Right (key "known")
        readIORef calls `shouldReturn` 3
    it "throttles unknown keys for exactly sixty seconds relative to the miss" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        calls <- newIORef (0 :: Int)
        let fetch = modifyIORef' calls (+ 1) >> pure (Right (JWKSDocument [key "known"]))
            lookupAt time kid = lookupOrFetchJWKWith fetch (pure time) 300 "url" kid
        lookupAt 1000 "known" `shouldReturn` Right (key "known")
        lookupAt 1001 "missing" `shouldReturn` Left "unknown kid"
        lookupAt 1060 "missing" `shouldReturn` Left "unknown kid"
        readIORef calls `shouldReturn` 2
        lookupAt 1061 "missing" `shouldReturn` Left "unknown kid"
        readIORef calls `shouldReturn` 3
    it "does not cache a failed fetch" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        lookupOrFetchJWKWith (pure (Left "private detail")) (pure 1000) 300 "url" "known" `shouldReturn` Left "JWKS fetch failed"
        lookupOrFetchJWKWith (pure (Right (JWKSDocument [key "known"]))) (pure 1000) 300 "url" "known" `shouldReturn` Right (key "known")
    it "rejects ambiguous cached keys without refetching" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        calls <- newIORef (0 :: Int)
        let fetch = modifyIORef' calls (+ 1) >> pure (Right (JWKSDocument [key "known", key "duplicate", key "duplicate"]))
            lookupKid = lookupOrFetchJWKWith fetch (pure 1000) 300 "url"
        lookupKid "known" `shouldReturn` Right (key "known")
        lookupKid "duplicate" `shouldReturn` Left "ambiguous kid"
        readIORef calls `shouldReturn` 1
    it "restores miss retry eligibility after an uninformative refresh" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        let lookupWith fetch kid = lookupOrFetchJWKWith fetch (pure 1000) 300 "url" kid
        lookupWith (pure (Right (JWKSDocument [key "known"]))) "known" `shouldReturn` Right (key "known")
        lookupWith (pure (Left "offline")) "new" `shouldReturn` Left "JWKS fetch failed"
        lookupWith (pure (Right (JWKSDocument [key "new"]))) "new" `shouldReturn` Right (key "new")
    it "does not install empty or ambiguous fetch results" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        let lookupWith fetch = lookupOrFetchJWKWith (pure (Right fetch)) (pure 1000) 300 "url" "known"
        lookupWith (JWKSDocument []) `shouldReturn` Left "unknown kid"
        lookupWith (JWKSDocument [key "known", key "known"]) `shouldReturn` Left "ambiguous kid"
        lookupWith (JWKSDocument [key "known"]) `shouldReturn` Right (key "known")
    it "does not let a slow older fetch overwrite a newer committed key" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        started <- newEmptyMVar
        release <- newEmptyMVar
        finished <- newEmptyMVar
        let slowFetch = putMVar started () >> takeMVar release >> pure (Right (JWKSDocument [key "old"]))
        worker <- forkIO $ lookupOrFetchJWKWith slowFetch (pure 1000) 300 "url" "old" >>= putMVar finished
        flip finally (killThread worker) $ do
            takeMVar started
            lookupOrFetchJWKWith (pure (Right (JWKSDocument [key "new"]))) (pure 1001) 300 "url" "new" `shouldReturn` Right (key "new")
            putMVar release ()
            takeMVar finished `shouldReturn` Right (key "old")
            lookupOrFetchJWKWith (expectationFailure "newer committed cache was overwritten" >> pure (Left "unexpected fetch")) (pure 1002) 300 "url" "new" `shouldReturn` Right (key "new")
    it "never reuses an entry with a zero TTL even in the same second" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        calls <- newIORef (0 :: Int)
        let fetch = modifyIORef' calls (+ 1) >> pure (Right (JWKSDocument [key "known"]))
            lookupKey = lookupOrFetchJWKWith fetch (pure 1000) 0 "url" "known"
        lookupKey `shouldReturn` Right (key "known")
        lookupKey `shouldReturn` Right (key "known")
        readIORef calls `shouldReturn` 2
    it "does not reuse another URL's known key when that URL fails" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        let lookupWith url fetch = lookupOrFetchJWKWith fetch (pure 1000) 300 url "known"
        lookupWith "first" (pure (Right (JWKSDocument [key "known"]))) `shouldReturn` Right (key "known")
        lookupWith "second" (pure (Left "offline")) `shouldReturn` Left "JWKS fetch failed"
        lookupWith "first" (expectationFailure "failed foreign fetch evicted the cached key" >> pure (Left "unexpected")) `shouldReturn` Right (key "known")
    it "does not serve an expired key after refresh failure and retries immediately" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        let lookupAt time fetch = lookupOrFetchJWKWith fetch (pure time) 300 "url" "known"
        lookupAt 1000 (pure (Right (JWKSDocument [key "known"]))) `shouldReturn` Right (key "known")
        lookupAt 1300 (pure (Left "offline")) `shouldReturn` Left "JWKS fetch failed"
        lookupAt 1300 (pure (Right (JWKSDocument [key "known"]))) `shouldReturn` Right (key "known")
    it "preserves the known key and retry eligibility after empty and ambiguous miss refreshes" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        let lookupWith fetch kid = lookupOrFetchJWKWith fetch (pure 1000) 300 "url" kid
            noFetch = expectationFailure "uninformative refresh replaced the known key" >> pure (Left "unexpected")
        lookupWith (pure (Right (JWKSDocument [key "known"]))) "known" `shouldReturn` Right (key "known")
        lookupWith (pure (Right (JWKSDocument []))) "new" `shouldReturn` Left "unknown kid"
        lookupWith noFetch "known" `shouldReturn` Right (key "known")
        lookupWith (pure (Right (JWKSDocument [key "new", key "new"]))) "new" `shouldReturn` Left "ambiguous kid"
        lookupWith noFetch "known" `shouldReturn` Right (key "known")
        lookupWith (pure (Right (JWKSDocument [key "new"]))) "new" `shouldReturn` Right (key "new")
    it "does not clear a newer entry's miss throttle when an older refresh fails" $ bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting $ do
        let lookupAt time fetch kid = lookupOrFetchJWKWith fetch (pure time) 300 "url" kid
            failingRefresh = do
                lookupAt 1300 (pure (Right (JWKSDocument [key "new"]))) "missing" `shouldReturn` Left "unknown kid"
                pure (Left "offline")
            noFetch = expectationFailure "older failure cleared the newer miss throttle" >> pure (Left "unexpected")
        lookupAt 1000 (pure (Right (JWKSDocument [key "known"]))) "known" `shouldReturn` Right (key "known")
        lookupAt 1001 failingRefresh "missing" `shouldReturn` Left "JWKS fetch failed"
        lookupAt 1301 noFetch "missing" `shouldReturn` Left "unknown kid"
        lookupAt 1301 noFetch "new" `shouldReturn` Right (key "new")

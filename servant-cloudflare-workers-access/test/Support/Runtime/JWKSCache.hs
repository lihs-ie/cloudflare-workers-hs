module Support.Runtime.JWKSCache (runJWKSCacheScenarios) where

import Control.Concurrent (forkFinally, killThread)
import Control.Concurrent.MVar (newEmptyMVar, putMVar, takeMVar)
import Control.Exception (bracket_, finally, throwIO)
import Control.Monad (unless)
import Data.Aeson (object, (.=))
import Data.IORef (modifyIORef', newIORef, readIORef)
import Data.Text (Text)
import Servant.Cloudflare.Workers.Access.Internal.JWKS (JWKSDocument (..))
import Servant.Cloudflare.Workers.Access.Internal.JWKSCache
import Servant.Cloudflare.Workers.Access.SubtleCrypto (JWK (..))

-- | Runtime-neutral cache contracts: each scenario owns and resets the global cache.
runJWKSCacheScenarios :: IO [Text]
runJWKSCacheScenarios = sequence
    [ scenario "ttl-boundary" $ do
        calls <- newIORef (0 :: Int)
        let fetch = modifyIORef' calls (+ 1) >> pure (Right (document ["known"]))
            lookupAt time = lookupOrFetchJWKWith fetch (pure time) 300 "url" "known"
        expect (Right (key "known")) =<< lookupAt 1000
        expect (Right (key "known")) =<< lookupAt 1299
        expect 1 =<< readIORef calls
        expect (Right (key "known")) =<< lookupAt 1300
        expect 2 =<< readIORef calls
    , scenario "url-isolation" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "first" (Right (document ["known"])) "known"
        expect (Left "JWKS fetch failed") =<< lookupAt 1000 "second" (Left "offline") "known"
        expect (Right (key "known")) =<< lookupAt 1000 "first" (Left "must remain cached") "known"
    , scenario "expired-refresh-recovery" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "url" (Right (document ["known"])) "known"
        expect (Left "JWKS fetch failed") =<< lookupAt 1300 "url" (Left "offline") "known"
        expect (Right (key "known")) =<< lookupAt 1300 "url" (Right (document ["known"])) "known"
    , scenario "uninformative-miss-recovery" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "url" (Right (document ["known"])) "known"
        expect (Left "JWKS fetch failed") =<< lookupAt 1001 "url" (Left "offline") "new"
        expect (Left "unknown kid") =<< lookupAt 1001 "url" (Right (document [])) "new"
        expect (Left "ambiguous kid") =<< lookupAt 1001 "url" (Right (document ["new", "new"])) "new"
        expect (Right (key "known")) =<< lookupAt 1001 "url" (Left "must remain cached") "known"
        expect (Right (key "new")) =<< lookupAt 1001 "url" (Right (document ["new"])) "new"
    , scenario "miss-throttle-boundary" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "url" (Right (document ["known"])) "known"
        expect (Left "unknown kid") =<< lookupAt 1001 "url" (Right (document ["known"])) "new"
        expect (Left "unknown kid") =<< lookupAt 1060 "url" (Left "must be throttled") "new"
        expect (Right (key "new")) =<< lookupAt 1061 "url" (Right (document ["new"])) "new"
    , scenario "zero-ttl" $ do
        let lookupWith value = lookupOrFetchJWKWith (pure value) (pure 1000) 0 "url" "known"
        expect (Right (key "known")) =<< lookupWith (Right (document ["known"]))
        expect (Left "JWKS fetch failed") =<< lookupWith (Left "must refetch")
    , scenario "cached-ambiguity" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "url" (Right (document ["known", "duplicate", "duplicate"])) "known"
        expect (Left "ambiguous kid") =<< lookupAt 1000 "url" (Left "must not refetch") "duplicate"
    , scenario "newer-throttle-survives-older-failure" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "url" (Right (document ["known"])) "known"
        let olderFetch = do
                expect (Left "unknown kid") =<< lookupAt 1300 "url" (Right (document ["new"])) "missing"
                pure (Left "offline")
        expect (Left "JWKS fetch failed") =<< lookupOrFetchJWKWith olderFetch (pure 1001) 300 "url" "missing"
        expect (Left "unknown kid") =<< lookupAt 1301 "url" (Left "must remain throttled") "missing"
        expect (Right (key "new")) =<< lookupAt 1301 "url" (Left "must remain cached") "new"
    , scenario "newer-key-survives-older-success" $ do
        started <- newEmptyMVar
        release <- newEmptyMVar
        finished <- newEmptyMVar
        calls <- newIORef (0 :: Int)
        let olderFetch = do
                modifyIORef' calls (+ 1)
                putMVar started ()
                takeMVar release
                pure (Right (document ["old"]))
            newerFetch = modifyIORef' calls (+ 1) >> pure (Right (document ["new"]))
            unexpectedFetch = modifyIORef' calls (+ 1) >> pure (Left "new key was overwritten")
        worker <- forkFinally
            (lookupOrFetchJWKWith olderFetch (pure 1000) 300 "url" "old")
            (putMVar finished)
        flip finally (killThread worker) $ do
            takeMVar started
            expect (Right (key "new")) =<< lookupOrFetchJWKWith newerFetch (pure 1001) 300 "url" "new"
            putMVar release ()
            olderResult <- takeMVar finished
            either throwIO (expect (Right (key "old"))) olderResult
            expect (Right (key "new")) =<< lookupOrFetchJWKWith unexpectedFetch (pure 1002) 300 "url" "new"
            expect 2 =<< readIORef calls
    , scenario "foreign-url-survives-older-failure" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "first" (Right (document ["known"])) "known"
        started <- newEmptyMVar
        release <- newEmptyMVar
        finished <- newEmptyMVar
        calls <- newIORef (0 :: Int)
        let olderFetch = do
                modifyIORef' calls (+ 1)
                putMVar started ()
                takeMVar release
                pure (Left "offline")
            unexpectedFetch = modifyIORef' calls (+ 1) >> pure (Left "foreign cache was changed")
        worker <- forkFinally
            (lookupOrFetchJWKWith olderFetch (pure 1001) 300 "first" "missing")
            (putMVar finished)
        flip finally (killThread worker) $ do
            takeMVar started
            expect (Left "unknown kid") =<< lookupAt 1002 "second" (Right (document ["foreign"])) "missing"
            putMVar release ()
            olderResult <- takeMVar finished
            either throwIO (expect (Left "JWKS fetch failed")) olderResult
            expect (Right (key "foreign")) =<< lookupOrFetchJWKWith unexpectedFetch (pure 1003) 300 "second" "foreign"
            expect (Left "unknown kid") =<< lookupOrFetchJWKWith unexpectedFetch (pure 1003) 300 "second" "missing"
            expect 1 =<< readIORef calls
    , scenario "newer-miss-stamp-survives-older-failure" $ do
        expect (Right (key "known")) =<< lookupAt 1000 "url" (Right (document ["known"])) "known"
        firstStarted <- newEmptyMVar
        firstRelease <- newEmptyMVar
        firstFinished <- newEmptyMVar
        secondStarted <- newEmptyMVar
        secondRelease <- newEmptyMVar
        secondFinished <- newEmptyMVar
        calls <- newIORef (0 :: Int)
        let firstFetch = do
                modifyIORef' calls (+ 1)
                putMVar firstStarted ()
                takeMVar firstRelease
                pure (Left "offline")
            secondFetch = do
                modifyIORef' calls (+ 1)
                putMVar secondStarted ()
                takeMVar secondRelease
                pure (Right (document ["new"]))
            unexpectedFetch = modifyIORef' calls (+ 1) >> pure (Left "newer miss stamp was cleared")
        firstWorker <- forkFinally
            (lookupOrFetchJWKWith firstFetch (pure 1001) 300 "url" "missing")
            (putMVar firstFinished)
        flip finally (killThread firstWorker) $ do
            takeMVar firstStarted
            secondWorker <- forkFinally
                (lookupOrFetchJWKWith secondFetch (pure 1062) 300 "url" "new")
                (putMVar secondFinished)
            flip finally (killThread secondWorker) $ do
                takeMVar secondStarted
                putMVar firstRelease ()
                firstResult <- takeMVar firstFinished
                either throwIO (expect (Left "JWKS fetch failed")) firstResult
                expect (Left "unknown kid") =<< lookupOrFetchJWKWith unexpectedFetch (pure 1063) 300 "url" "missing"
                expect 2 =<< readIORef calls
                putMVar secondRelease ()
                secondResult <- takeMVar secondFinished
                either throwIO (expect (Right (key "new"))) secondResult
                expect (Right (key "new")) =<< lookupOrFetchJWKWith unexpectedFetch (pure 1064) 300 "url" "new"
                expect 2 =<< readIORef calls
    ]
  where
    scenario name action = bracket_ resetJWKSCacheForTesting resetJWKSCacheForTesting (action >> pure name)
    lookupAt time url fetched kid = lookupOrFetchJWKWith (pure fetched) (pure time) 300 url kid

expect :: (Eq a, Show a) => a -> a -> IO ()
expect expected actual = unless (expected == actual) $ ioError $ userError $
    "JWKS cache contract: expected " <> show expected <> ", got " <> show actual

key :: Text -> JWK
key kid = JWK kid (object ["kid" .= kid])

document :: [Text] -> JWKSDocument
document = JWKSDocument . map key

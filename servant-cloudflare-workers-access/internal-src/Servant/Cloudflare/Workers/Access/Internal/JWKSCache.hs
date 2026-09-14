module Servant.Cloudflare.Workers.Access.Internal.JWKSCache (
    JWKSCacheEntry (..),
    jwksKidMissThrottleSeconds,
    lookupOrFetchJWKWith,
    resetJWKSCacheForTesting,
) where

import Data.IORef (IORef, atomicModifyIORef', newIORef, writeIORef)
import Data.Text (Text)
import Servant.Cloudflare.Workers.Access.Internal.JWKS (JWKSDocument (jwksDocumentKeys), JWKSLookupError (JWKSKidAmbiguous, JWKSKidNotFound), findJWKByKid)
import Servant.Cloudflare.Workers.Access.SubtleCrypto (JWK)
import System.IO.Unsafe (unsafePerformIO)

data JWKSCacheEntry = JWKSCacheEntry
    { cacheEntryURL :: Text
    , cacheEntryFetchedAtSeconds :: Integer
    , cacheEntryDocument :: JWKSDocument
    , cacheEntryKidMissRefetchAtSeconds :: Maybe Integer
    }
    deriving stock (Show, Eq)

jwksKidMissThrottleSeconds :: Integer
jwksKidMissThrottleSeconds = 60

data JWKSCacheSlot = JWKSCacheSlot
    { cacheSlotCommittedFetchSequence :: Integer
    , cacheSlotEntry :: JWKSCacheEntry
    }

data JWKSCacheState = JWKSCacheState
    { cacheStateSlot :: Maybe JWKSCacheSlot
    , cacheStateLastIssuedFetchSequence :: Integer
    }

initialJWKSCacheState :: JWKSCacheState
initialJWKSCacheState = JWKSCacheState Nothing 0

{-# NOINLINE jwksCacheRef #-}
jwksCacheRef :: IORef JWKSCacheState
jwksCacheRef = unsafePerformIO (newIORef initialJWKSCacheState)

lookupOrFetchJWKWith ::
    IO (Either Text JWKSDocument) ->
    IO Integer ->
    Integer ->
    Text ->
    Text ->
    IO (Either Text JWK)
lookupOrFetchJWKWith fetchAction nowAction ttlSeconds url kid = do
    now <- nowAction
    decision <- atomicModifyIORef' jwksCacheRef (decideAndArm now)
    case decision of
        ServerCachedJWK jwk -> pure (Right jwk)
        RejectAmbiguousKid -> pure (Left "ambiguous kid")
        RejectThrottledKidMiss -> pure (Left "unknown kid")
        Refetch fetchSequence throttleArming -> refetchAndLookup now fetchSequence throttleArming
  where
    decideAndArm now cacheState =
        case cacheStateSlot cacheState of
            Just cacheSlot
                | entryIsFresh now entry ->
                    case findJWKByKid kid (cacheEntryDocument entry) of
                        Right jwk -> (cacheState, ServerCachedJWK jwk)
                        Left JWKSKidAmbiguous -> (cacheState, RejectAmbiguousKid)
                        Left JWKSKidNotFound
                            | kidMissRefetchIsThrottled now entry -> (cacheState, RejectThrottledKidMiss)
                            | otherwise ->
                                startRefetch
                                    (Just cacheSlot{cacheSlotEntry = entry{cacheEntryKidMissRefetchAtSeconds = Just now}})
                                    ( ThrottleArmedByThisLookup
                                        now
                                        (cacheSlotCommittedFetchSequence cacheSlot)
                                        (cacheEntryKidMissRefetchAtSeconds entry)
                                    )
                                    cacheState
              where
                entry = cacheSlotEntry cacheSlot
            _uncachedOrStale ->
                startRefetch
                    (cacheStateSlot cacheState)
                    ThrottleUntouchedByThisLookup
                    cacheState

    entryIsFresh :: Integer -> JWKSCacheEntry -> Bool
    entryIsFresh now entry =
        cacheEntryURL entry == url && now - cacheEntryFetchedAtSeconds entry < ttlSeconds

    startRefetch :: Maybe JWKSCacheSlot -> ThrottleArming -> JWKSCacheState -> (JWKSCacheState, JWKSCacheDecision)
    startRefetch nextSlot throttleArming cacheState =
        ( cacheState
            { cacheStateSlot = nextSlot
            , cacheStateLastIssuedFetchSequence = fetchSequence
            }
        , Refetch fetchSequence throttleArming
        )
      where
        fetchSequence = cacheStateLastIssuedFetchSequence cacheState + 1

    kidMissRefetchIsThrottled :: Integer -> JWKSCacheEntry -> Bool
    kidMissRefetchIsThrottled now entry =
        case cacheEntryKidMissRefetchAtSeconds entry of
            Nothing -> False
            Just kidMissRefetchAtSeconds -> now - kidMissRefetchAtSeconds < jwksKidMissThrottleSeconds

    refetchAndLookup :: Integer -> Integer -> ThrottleArming -> IO (Either Text JWK)
    refetchAndLookup fetchedAtSeconds fetchSequence throttleArming = do
        fetched <- fetchAction
        case fetched of
            Left _fetchError -> uninformativeOutcome throttleArming (Left "JWKS fetch failed")
            Right document
                | null (jwksDocumentKeys document) -> uninformativeOutcome throttleArming (Left "unknown kid")
                | otherwise ->
                    case findJWKByKid kid document of
                        Right jwk -> do
                            commitFetchedEntryIfCurrent
                                fetchSequence
                                (JWKSCacheEntry url fetchedAtSeconds document Nothing)
                            pure (Right jwk)
                        Left JWKSKidAmbiguous -> uninformativeOutcome throttleArming (Left "ambiguous kid")
                        Left JWKSKidNotFound -> do
                            commitFetchedEntryIfCurrent
                                fetchSequence
                                (JWKSCacheEntry url fetchedAtSeconds document (Just fetchedAtSeconds))
                            pure (Left "unknown kid")

    commitFetchedEntryIfCurrent :: Integer -> JWKSCacheEntry -> IO ()
    commitFetchedEntryIfCurrent fetchSequence entry =
        atomicModifyIORef' jwksCacheRef commit
      where
        commit :: JWKSCacheState -> (JWKSCacheState, ())
        commit cacheState =
            case cacheStateSlot cacheState of
                Just cacheSlot
                    | cacheSlotCommittedFetchSequence cacheSlot > fetchSequence ->
                        (cacheState, ())
                _currentOrEmpty ->
                    ( cacheState
                        { cacheStateSlot =
                            Just
                                JWKSCacheSlot
                                    { cacheSlotCommittedFetchSequence = fetchSequence
                                    , cacheSlotEntry = entry
                                    }
                        }
                    , ()
                    )

    uninformativeOutcome :: ThrottleArming -> Either Text JWK -> IO (Either Text JWK)
    uninformativeOutcome ThrottleUntouchedByThisLookup outcome = pure outcome
    uninformativeOutcome (ThrottleArmedByThisLookup armedAtSeconds armedEntrySequence previousArmingStamp) outcome = do
        atomicModifyIORef' jwksCacheRef restorePreviousArmingStamp
        pure outcome
      where
        restorePreviousArmingStamp :: JWKSCacheState -> (JWKSCacheState, ())
        restorePreviousArmingStamp cacheState = case cacheStateSlot cacheState of
            Just cacheSlot
                | cacheEntryURL entry == url
                , cacheSlotCommittedFetchSequence cacheSlot == armedEntrySequence
                , cacheEntryKidMissRefetchAtSeconds entry == Just armedAtSeconds ->
                    ( cacheState
                        { cacheStateSlot =
                            Just cacheSlot{cacheSlotEntry = entry{cacheEntryKidMissRefetchAtSeconds = previousArmingStamp}}
                        }
                    , ()
                    )
              where
                entry = cacheSlotEntry cacheSlot
            _replacedOrEvicted -> (cacheState, ())

data ThrottleArming
    = ThrottleUntouchedByThisLookup
    | ThrottleArmedByThisLookup Integer Integer (Maybe Integer)

data JWKSCacheDecision
    = ServerCachedJWK JWK
    | RejectAmbiguousKid
    | RejectThrottledKidMiss
    | Refetch Integer ThrottleArming

resetJWKSCacheForTesting :: IO ()
resetJWKSCacheForTesting = writeIORef jwksCacheRef initialJWKSCacheState

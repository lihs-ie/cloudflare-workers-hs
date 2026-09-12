module Cloudflare.Workers.Cache (
  CacheStorage,
  Cache,
  CacheKey (..),
  CacheQueryOptions (..),
  cacheQueryDefaultOptions,
  CachePutFailureKind (..),
  CacheError (..),
  cacheStorage,
  cacheDefault,
  cacheOpen,
  cachePut,
  cacheMatch,
  cacheDelete,
  classifyCachePutFailureMessage,
  CacheControlDirective (..),
  renderCacheControl,
  cacheTagHeaderName,
  cacheTagHeader,
  CachePurgeOptions (..),
  CachePurgeError (..),
  CachePurgeResult (..),
  CachePurgeFailed (..),
  cachePurge,
  handleCachePurgeOutcome,
) where

import Control.Exception (Exception, throwIO)
import Data.Maybe (catMaybes)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Internal.FFI.Cache (
  CacheKeyViaFFI (CacheRequestKeyViaFFI, CacheURLKeyViaFFI),
  cacheAPIDefaultViaFFI,
  cacheAPIDeleteViaFFI,
  cacheAPIMatchViaFFI,
  cacheAPIOpenViaFFI,
  cacheAPIPutViaFFI,
  cachePurgeViaFFI,
  cacheStorageViaFFI,
 )
import Cloudflare.Workers.Reactor (WorkersExecutionContext (WorkersExecutionContext))

newtype CacheStorage = CacheStorage JSVal

newtype Cache = Cache JSVal

data CacheKey
  = CacheRequest Request
  | CacheURL Text

newtype CacheQueryOptions = CacheQueryOptions
  { cacheQueryOptionsIgnoreMethod :: Bool
  }
  deriving stock (Show, Eq)

cacheQueryDefaultOptions :: CacheQueryOptions
cacheQueryDefaultOptions = CacheQueryOptions False

data CachePutFailureKind
  = CachePutInvalidMethod
  | CachePutPartialResponse
  | CachePutVaryWildcard
  | CachePutNotCacheableOrTooLarge
  | CachePutOther
  deriving stock (Show, Eq)

data CacheError
  = CacheOpenFailed Text
  | CachePutRejected CachePutFailureKind Text
  | CacheMatchFailed Text
  | CacheDeleteFailed Text
  deriving stock (Show, Eq)

instance Exception CacheError

cacheStorage :: IO CacheStorage
cacheStorage = CacheStorage <$> cacheStorageViaFFI

cacheDefault :: CacheStorage -> IO Cache
cacheDefault (CacheStorage storageJSVal) = Cache <$> cacheAPIDefaultViaFFI storageJSVal

cacheOpen :: CacheStorage -> Text -> IO Cache
cacheOpen (CacheStorage storageJSVal) name = do
  outcome <- cacheAPIOpenViaFFI storageJSVal name
  either (throwIO . CacheOpenFailed) (pure . Cache) outcome

cachePut :: Cache -> CacheKey -> Response -> IO ()
cachePut (Cache cacheJSVal) key response = do
  outcome <- cacheAPIPutViaFFI cacheJSVal (toCacheKeyViaFFI key) response
  either (\message -> throwIO (CachePutRejected (classifyCachePutFailureMessage message) message)) pure outcome

cacheMatch :: Cache -> CacheKey -> CacheQueryOptions -> IO (Maybe Response)
cacheMatch (Cache cacheJSVal) key options = do
  outcome <- cacheAPIMatchViaFFI cacheJSVal (toCacheKeyViaFFI key) (cacheQueryOptionsIgnoreMethod options)
  either (throwIO . CacheMatchFailed) pure outcome

cacheDelete :: Cache -> CacheKey -> CacheQueryOptions -> IO Bool
cacheDelete (Cache cacheJSVal) key options = do
  outcome <- cacheAPIDeleteViaFFI cacheJSVal (toCacheKeyViaFFI key) (cacheQueryOptionsIgnoreMethod options)
  either (throwIO . CacheDeleteFailed) pure outcome

toCacheKeyViaFFI :: CacheKey -> CacheKeyViaFFI
toCacheKeyViaFFI (CacheRequest request) = CacheRequestKeyViaFFI request
toCacheKeyViaFFI (CacheURL url) = CacheURLKeyViaFFI url

classifyCachePutFailureMessage :: Text -> CachePutFailureKind
classifyCachePutFailureMessage message
  | contains "only support get" || contains "request method" || contains "cannot cache response to non-get request" = CachePutInvalidMethod
  | contains "range request" || contains "partial response" || contains "status 206" = CachePutPartialResponse
  | contains "vary" && contains "*" = CachePutVaryWildcard
  | contains "too large" || contains "not cacheable" = CachePutNotCacheableOrTooLarge
  | otherwise = CachePutOther
  where
    normalized = Text.toLower message
    contains fragment = fragment `Text.isInfixOf` normalized

data CacheControlDirective
  = CachePublic
      { cacheControlDirectiveMaxAge :: Maybe Int
      , cacheControlDirectiveSMaxAge :: Maybe Int
      , cacheControlDirectiveStaleWhileRevalidate :: Maybe Int
      }
  | CachePrivate
      { cacheControlDirectiveMaxAge :: Maybe Int
      , cacheControlDirectiveSMaxAge :: Maybe Int
      , cacheControlDirectiveStaleWhileRevalidate :: Maybe Int
      }
  | CacheNoStore
  deriving stock (Show, Eq)

renderCacheControl :: CacheControlDirective -> Text
renderCacheControl CacheNoStore = "no-store"
renderCacheControl (CachePublic maxAge sMaxAge staleWhileRevalidate) =
  Text.intercalate ", " ("public" : renderCacheControlFields maxAge sMaxAge staleWhileRevalidate)
renderCacheControl (CachePrivate maxAge sMaxAge staleWhileRevalidate) =
  Text.intercalate ", " ("private" : renderCacheControlFields maxAge sMaxAge staleWhileRevalidate)

renderCacheControlFields :: Maybe Int -> Maybe Int -> Maybe Int -> [Text]
renderCacheControlFields maxAge sMaxAge staleWhileRevalidate =
  catMaybes
    [ renderCacheControlField "max-age" maxAge
    , renderCacheControlField "s-maxage" sMaxAge
    , renderCacheControlField "stale-while-revalidate" staleWhileRevalidate
    ]

renderCacheControlField :: Text -> Maybe Int -> Maybe Text
renderCacheControlField directiveName maybeSeconds =
  (\seconds -> directiveName <> "=" <> Text.pack (show seconds)) <$> maybeSeconds

cacheTagHeaderName :: Text
cacheTagHeaderName = "Cache-Tag"

cacheTagHeader :: [Text] -> Maybe (Text, Text)
cacheTagHeader [] = Nothing
cacheTagHeader tags = Just (cacheTagHeaderName, Text.intercalate "," tags)

data CachePurgeOptions
  = PurgeTags [Text]
  | PurgePathPrefixes [Text]
  | PurgeEverything
  deriving stock (Show, Eq)

data CachePurgeError = CachePurgeError
  { cachePurgeErrorCode :: Int
  , cachePurgeErrorMessage :: Text
  }
  deriving stock (Show, Eq)

data CachePurgeResult = CachePurgeResult
  { cachePurgeResultSuccess :: Bool
  , cachePurgeResultErrors :: [CachePurgeError]
  }
  deriving stock (Show, Eq)

newtype CachePurgeFailed = CachePurgeFailed Text
  deriving stock (Show, Eq)

instance Exception CachePurgeFailed

cachePurge :: WorkersExecutionContext -> CachePurgeOptions -> IO CachePurgeResult
cachePurge (WorkersExecutionContext ctxJSVal) options =
  handleCachePurgeOutcome
    =<< cachePurgeViaFFI ctxJSVal (purgeTagsOf options) (purgePathPrefixesOf options) (purgeEverythingOf options)
  where
    purgeTagsOf (PurgeTags tags) = Just tags
    purgeTagsOf _ = Nothing
    purgePathPrefixesOf (PurgePathPrefixes pathPrefixes) = Just pathPrefixes
    purgePathPrefixesOf _ = Nothing
    purgeEverythingOf PurgeEverything = True
    purgeEverythingOf _ = False

handleCachePurgeOutcome :: Either Text (Bool, [(Int, Text)]) -> IO CachePurgeResult
handleCachePurgeOutcome = either (throwIO . CachePurgeFailed) (pure . toCachePurgeResult)
  where
    toCachePurgeResult (success, errors) =
      CachePurgeResult
        { cachePurgeResultSuccess = success
        , cachePurgeResultErrors = fmap (uncurry CachePurgeError) errors
        }


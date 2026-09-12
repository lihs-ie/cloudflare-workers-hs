{-# LANGUAGE DataKinds #-}
{-# OPTIONS_GHC -Wno-orphans #-}

module Servant.Cloudflare.Workers.CacheControl (
    CacheDirective (..),
    CacheControlled,
    cacheControlledHeaderValue,
    uncacheableErrorStatusFloor,
    errorCacheControlHeaderValue,
    varyHeaderName,
    varyOnAcceptHeaderValue,
) where

import Data.Proxy (Proxy (Proxy))
import Data.Text (Text)
import GHC.TypeLits (KnownNat, Nat, natVal)

import Cloudflare.Workers.Cache (
    CacheControlDirective (CacheNoStore, CachePrivate, CachePublic),
    renderCacheControl,
 )
import Cloudflare.Workers.HTTP (Response (responseHeaders, responseStatus), Status (statusCode))
import Cloudflare.Workers.Headers (Headers, headerInsert, headerLookup)
import Servant.API ((:>))
import Servant.Cloudflare.Workers.Handler (Handler)
import Servant.Cloudflare.Workers.Server (Context, HasWorkerServer (ServerT, route))
import Servant.Cloudflare.Workers.Server.Internal.Delayed (Delayed)
import Servant.Cloudflare.Workers.Server.Internal.Router (Router, RoutingApplication)

data CacheDirective
    = MaxAge Nat
    | SMaxAge Nat
    | StaleWhileRevalidate Nat
    | Public
    | Private
    | NoStore

data CacheControlled (directives :: [CacheDirective])

data CacheDirectiveToken
    = TokenMaxAge Int
    | TokenSMaxAge Int
    | TokenStaleWhileRevalidate Int
    | TokenPublic
    | TokenPrivate
    | TokenNoStore

class KnownCacheDirective (directive :: CacheDirective) where
    cacheDirectiveToken :: Proxy directive -> CacheDirectiveToken

instance (KnownNat seconds) => KnownCacheDirective (MaxAge seconds) where
    cacheDirectiveToken Proxy = TokenMaxAge (fromInteger (natVal (Proxy :: Proxy seconds)))

instance (KnownNat seconds) => KnownCacheDirective (SMaxAge seconds) where
    cacheDirectiveToken Proxy = TokenSMaxAge (fromInteger (natVal (Proxy :: Proxy seconds)))

instance (KnownNat seconds) => KnownCacheDirective (StaleWhileRevalidate seconds) where
    cacheDirectiveToken Proxy = TokenStaleWhileRevalidate (fromInteger (natVal (Proxy :: Proxy seconds)))

instance KnownCacheDirective Public where
    cacheDirectiveToken Proxy = TokenPublic

instance KnownCacheDirective Private where
    cacheDirectiveToken Proxy = TokenPrivate

instance KnownCacheDirective NoStore where
    cacheDirectiveToken Proxy = TokenNoStore

class KnownCacheDirectives (directives :: [CacheDirective]) where
    cacheDirectiveTokens :: Proxy directives -> [CacheDirectiveToken]

instance KnownCacheDirectives '[] where
    cacheDirectiveTokens Proxy = []

instance
    (KnownCacheDirective directive, KnownCacheDirectives directives) =>
    KnownCacheDirectives (directive ': directives)
    where
    cacheDirectiveTokens Proxy = cacheDirectiveToken (Proxy :: Proxy directive) : cacheDirectiveTokens (Proxy :: Proxy directives)

data CacheDirectiveMode = ModePublic | ModePrivate | ModeNoStore

data CacheDirectiveAccumulator = CacheDirectiveAccumulator
    { cacheDirectiveAccumulatorMode :: CacheDirectiveMode
    , cacheDirectiveAccumulatorMaxAge :: Maybe Int
    , cacheDirectiveAccumulatorSMaxAge :: Maybe Int
    , cacheDirectiveAccumulatorStaleWhileRevalidate :: Maybe Int
    }

emptyCacheDirectiveAccumulator :: CacheDirectiveAccumulator
emptyCacheDirectiveAccumulator = CacheDirectiveAccumulator ModePrivate Nothing Nothing Nothing

accumulateCacheDirectiveToken :: CacheDirectiveAccumulator -> CacheDirectiveToken -> CacheDirectiveAccumulator
accumulateCacheDirectiveToken accumulator token = case token of
    TokenMaxAge seconds -> accumulator{cacheDirectiveAccumulatorMaxAge = Just seconds}
    TokenSMaxAge seconds -> accumulator{cacheDirectiveAccumulatorSMaxAge = Just seconds}
    TokenStaleWhileRevalidate seconds -> accumulator{cacheDirectiveAccumulatorStaleWhileRevalidate = Just seconds}
    TokenPublic -> accumulator{cacheDirectiveAccumulatorMode = ModePublic}
    TokenPrivate -> accumulator{cacheDirectiveAccumulatorMode = ModePrivate}
    TokenNoStore -> accumulator{cacheDirectiveAccumulatorMode = ModeNoStore}

cacheDirectiveTokensToCacheControlDirective :: [CacheDirectiveToken] -> CacheControlDirective
cacheDirectiveTokensToCacheControlDirective tokens = case cacheDirectiveAccumulatorMode accumulator of
    ModeNoStore -> CacheNoStore
    ModePrivate ->
        CachePrivate
            (cacheDirectiveAccumulatorMaxAge accumulator)
            (cacheDirectiveAccumulatorSMaxAge accumulator)
            (cacheDirectiveAccumulatorStaleWhileRevalidate accumulator)
    ModePublic ->
        CachePublic
            (cacheDirectiveAccumulatorMaxAge accumulator)
            (cacheDirectiveAccumulatorSMaxAge accumulator)
            (cacheDirectiveAccumulatorStaleWhileRevalidate accumulator)
  where
    accumulator = foldl' accumulateCacheDirectiveToken emptyCacheDirectiveAccumulator tokens

cacheControlledHeaderValue :: (KnownCacheDirectives directives) => Proxy directives -> Text
cacheControlledHeaderValue directivesProxy =
    renderCacheControl (cacheDirectiveTokensToCacheControlDirective (cacheDirectiveTokens directivesProxy))

uncacheableErrorStatusFloor :: Int
uncacheableErrorStatusFloor = 400

errorCacheControlHeaderValue :: Text
errorCacheControlHeaderValue = renderCacheControl CacheNoStore

varyHeaderName :: Text
varyHeaderName = "Vary"

varyOnAcceptHeaderValue :: Text
varyOnAcceptHeaderValue = "Accept"

instance (KnownCacheDirectives directives, HasWorkerServer api context) => HasWorkerServer (CacheControlled directives :> api) context where
    type ServerT (CacheControlled directives :> api) m = ServerT api m

    route ::
        forall capEnv bindingEnv.
        Proxy (CacheControlled directives :> api) ->
        Context context ->
        Delayed capEnv (ServerT api (Handler bindingEnv)) ->
        Router capEnv bindingEnv
    route Proxy context delayedServer =
        fmap injectCacheControlHeader (route @api @context @capEnv @bindingEnv (Proxy :: Proxy api) context delayedServer)
      where
        cacheControlHeaderValue = cacheControlledHeaderValue (Proxy :: Proxy directives)

        injectCacheControlHeader :: RoutingApplication bindingEnv -> RoutingApplication bindingEnv
        injectCacheControlHeader routingApplication segments request cloudflareCtx bindingEnv = do
            routeResult <- routingApplication segments request cloudflareCtx bindingEnv
            pure (fmap addCacheControlHeader routeResult)

        addCacheControlHeader :: Response -> Response
        addCacheControlHeader response
            | Just _alreadyPresent <- headerLookup "Cache-Control" (responseHeaders response) = response
            | statusCode (responseStatus response) >= uncacheableErrorStatusFloor =
                response{responseHeaders = headerInsert "Cache-Control" errorCacheControlHeaderValue (responseHeaders response)}
            | otherwise =
                response
                    { responseHeaders =
                        addVaryOnAcceptHeader (headerInsert "Cache-Control" cacheControlHeaderValue (responseHeaders response))
                    }

        addVaryOnAcceptHeader :: Headers -> Headers
        addVaryOnAcceptHeader headers = case headerLookup varyHeaderName headers of
            Just _alreadyPresent -> headers
            Nothing -> headerInsert varyHeaderName varyOnAcceptHeaderValue headers

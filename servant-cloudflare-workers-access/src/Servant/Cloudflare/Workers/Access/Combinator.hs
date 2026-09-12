{-# OPTIONS_GHC -Wno-orphans #-}

module Servant.Cloudflare.Workers.Access.Combinator (
    ZeroTrust,
    AccessVerifier (..),
    ZeroTrustService,
    AccessServiceVerifier (..),
) where

import Servant.API ((:>))

import Cloudflare.Workers.HTTP (Request (requestHeaders))
import Cloudflare.Workers.Headers (headerLookup)
import Control.Exception (SomeException, evaluate, try)
import Control.Monad.IO.Class (MonadIO (liftIO))
import Data.Proxy (Proxy (Proxy))
import Data.Text (Text)
import Servant.Cloudflare.Workers.Access (AccessClaims, AccessServiceClaims, AccessError)
import Servant.Cloudflare.Workers.Error (err401)
import Servant.Cloudflare.Workers.Handler (Handler)
import Servant.Cloudflare.Workers.Server (Context, HasContextEntry (getContextEntry), HasWorkerServer (ServerT, route))
import Servant.Cloudflare.Workers.Server.Internal.Delayed (Delayed, addAuthCheck)
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (DelayedIO, delayedFailFatal, withRequest)
import Servant.Cloudflare.Workers.Server.Internal.Router (Router)

{- | Empty marker type: ZeroTrust :> api requires a verified Cloudflare
Access identity before dispatching into api. Never constructed --
ZeroTrust only ever appears as a type, the same way servant's own
combinators (Capture, ReqBody, ...) are type-level markers.
-}
data ZeroTrust

newtype AccessVerifier = AccessVerifier (Text -> IO (Either AccessError AccessClaims))

instance
    (HasContextEntry context AccessVerifier, HasWorkerServer api context) =>
    HasWorkerServer (ZeroTrust :> api) context
    where
    type ServerT (ZeroTrust :> api) m = AccessClaims -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (ZeroTrust :> api) ->
        Context context ->
        Delayed captureEnv (AccessClaims -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (addAuthCheck delayedServer verifyAccessRequest)
      where
        AccessVerifier verify = getContextEntry context :: AccessVerifier

        verifyAccessRequest = verifyRequest verify

-- | Require a service-token identity. A user verifier cannot satisfy this context.
data ZeroTrustService

newtype AccessServiceVerifier = AccessServiceVerifier (Text -> IO (Either AccessError AccessServiceClaims))

instance
    (HasContextEntry context AccessServiceVerifier, HasWorkerServer api context) =>
    HasWorkerServer (ZeroTrustService :> api) context
    where
    type ServerT (ZeroTrustService :> api) m = AccessServiceClaims -> ServerT api m
    route ::
        forall captureEnv bindingEnv.
        Proxy (ZeroTrustService :> api) ->
        Context context ->
        Delayed captureEnv (AccessServiceClaims -> ServerT api (Handler bindingEnv)) ->
        Router captureEnv bindingEnv
    route Proxy context delayedServer =
        route @api @context @captureEnv @bindingEnv (Proxy :: Proxy api) context (addAuthCheck delayedServer (verifyRequest verify))
      where
        AccessServiceVerifier verify = getContextEntry context :: AccessServiceVerifier

verifyRequest :: (Text -> IO (Either AccessError identity)) -> DelayedIO identity
verifyRequest verify = withRequest $ \request ->
    case headerLookup "Cf-Access-Jwt-Assertion" (requestHeaders request) of
        Nothing -> delayedFailFatal err401
        Just jwtAssertion -> do
            verificationResult <- liftIO $ try @SomeException $ do
                result <- verify jwtAssertion
                case result of
                    Left accessError -> pure (Left accessError)
                    Right claims -> Right <$> evaluate claims
            case verificationResult of
                Left _exception -> delayedFailFatal err401
                Right (Left _accessError) -> delayedFailFatal err401
                Right (Right claims) -> pure claims

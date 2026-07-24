{-# LANGUAGE DataKinds #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeOperators #-}

module Main (main) where

import Data.Proxy (Proxy (Proxy))
import Data.Text (Text)

import Test.Tasty (TestTree, defaultMain, testGroup)
import Test.Tasty.HUnit (testCase, (@?=))

import Servant.API (Get, JSON, (:>))
import Servant.Cloudflare.Workers.Access (AccessClaims, AccessConfig (..), AccessError (..), verifyAccessJWT)
import Servant.Cloudflare.Workers.Access.Combinator (ZeroTrust)
import Servant.Cloudflare.Workers.Internal ()
import Servant.Cloudflare.Workers.Server (HasWorkerServer (ServerT))

main :: IO ()
main = defaultMain tests

{- | Type-level only -- never called at runtime. If this definition
type-checks, GHC has confirmed that the HasWorkerServer instance for
ZeroTrust :> api really does reduce ServerT (ZeroTrust :> api) m to
AccessClaims -> ServerT api m, for any api that already has a
HasWorkerServer instance -- the compile-time proof that the combinator
injects AccessClaims as the handler's first argument.
-}
_zeroTrustInjectsAccessClaims ::
    Proxy (ServerT ProtectedApi IO)
_zeroTrustInjectsAccessClaims =
    Proxy :: Proxy (AccessClaims -> IO Text)

type ProtectedApi = ZeroTrust :> Get '[JSON] Text

mockAccessConfig :: AccessConfig
mockAccessConfig =
    AccessConfig "url-shortener-admin" "acme-team" "https://acme-team.cloudflareaccess.com/cdn-cgi/access/certs"

tests :: TestTree
tests =
    testGroup
        "servant-cloudflare-workers-access"
        [ testCase "AccessConfig record links" $
            accessConfigAudience (AccessConfig "aud" "team" "https://team.cloudflareaccess.com/cdn-cgi/access/certs")
                @?= "aud"
        , testCase "verifyAccessJWT: too few dot-separated parts is malformed" $ do
            result <- verifyAccessJWT mockAccessConfig "not-a-jwt"
            result @?= Left (AccessErrorMalformed "expected header.payload.signature")
        , testCase "verifyAccessJWT: too many dot-separated parts is malformed" $ do
            result <- verifyAccessJWT mockAccessConfig "a.b.c.d"
            result @?= Left (AccessErrorMalformed "expected header.payload.signature")
        ]

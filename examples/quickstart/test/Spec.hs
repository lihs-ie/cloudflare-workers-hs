module Main (main) where

import Data.Aeson (decode, encode)
import Data.Proxy (Proxy (Proxy))
import Data.Text qualified as Text
import Servant.Cloudflare.Workers.Handler (Handler)
import Servant.Cloudflare.Workers.Internal ()
import Servant.Cloudflare.Workers.Server (HasWorkerServer, ServerT)
import Test.Tasty (TestTree, defaultMain, testGroup)
import Test.Tasty.HUnit (testCase, (@?=))
import URLShortener.API
    ( AdminStats (AdminStats)
    , ExhaustiveAPI
    , ShortenRequest (ShortenRequest)
    , ShortenedURL (ShortenedURL)
    , URLShortenerApi
    )

main :: IO ()
main = defaultMain tests

tests :: TestTree
tests =
    testGroup
        "URLShortener.API"
        [ typeLevelTests
        , jsonTests
        ]

typeLevelTests :: TestTree
typeLevelTests =
    testGroup
        "type-level API shape"
        [ testCase "URLShortenerApi resolves through HasWorkerServer" $
            _urlShortenerServerTypeLinks @?= Proxy
        , testCase "ExhaustiveAPI is well-kinded as a Servant API type" $
            _exhaustiveApiProxy @?= Proxy
        ]

_urlShortenerServerTypeLinks ::
    HasWorkerServer URLShortenerApi =>
    Proxy (ServerT URLShortenerApi (Handler ()))
_urlShortenerServerTypeLinks = Proxy

_exhaustiveApiProxy :: Proxy ExhaustiveAPI
_exhaustiveApiProxy = Proxy

jsonTests :: TestTree
jsonTests =
    testGroup
        "JSON payloads"
        [ testCase "ShortenRequest round-trips through JSON" $
            decode (encode shortenRequest) @?= Just shortenRequest
        , testCase "ShortenedURL round-trips through JSON" $
            decode (encode shortenedURL) @?= Just shortenedURL
        , testCase "AdminStats round-trips through JSON" $
            decode (encode adminStats) @?= Just adminStats
        ]

shortenRequest :: ShortenRequest
shortenRequest =
    ShortenRequest (Text.pack "https://example.com")

shortenedURL :: ShortenedURL
shortenedURL =
    ShortenedURL (Text.pack "ab12cd") (Text.pack "https://example.com")

adminStats :: AdminStats
adminStats =
    AdminStats 1

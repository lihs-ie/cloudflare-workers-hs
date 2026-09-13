module Servant.Cloudflare.Workers.Client.Fetch.RequestSpec (spec) where

import Cloudflare.Workers.Headers (headerLookup)
import Data.ByteString (ByteString)
import Data.Sequence qualified as Seq
import Data.Text qualified as Text
import Hedgehog (forAll, property, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Network.HTTP.Media ((//))
#if MIN_VERSION_servant_client_core(0,21,0)
import Network.HTTP.Types (EscapeItem (..))
#endif
import Servant.Client.Core
import Servant.Cloudflare.Workers.Client.Fetch.Request
import Test.Syd
import Test.Syd.Hedgehog ()

spec :: Spec
spec = describe "Fetch request conversion" $ do
    it "preserves encoded values and separates query flags from empty values" $ do
        let request =
                appendQueryParameter
                    "q"
                    (queryValue (encodeQueryParamValue ("a&b=#% 日本" :: Text.Text)))
                    $ appendQueryParameter "empty" (queryValue "")
                    $ appendQueryParameter "flag" queryFlag defaultRequest
        buildFetchTargetURL (BaseUrl Https "example.com" 443 "/api") request
            `shouldBe` "https://example.com/api?flag&empty=&q="
                <> "a%26b%3D%23%25%20%E6%97%A5%E6%9C%AC"
    it "does not add query syntax when absent" $
        buildFetchTargetURL (BaseUrl Http "localhost" 8080 "") defaultRequest
            `shouldBe` "http://localhost:8080"
    it "generated safe query values survive conversion" $ property $ do
        value <- forAll $ Gen.text (Range.linear 0 100) Gen.alphaNum
        let request =
                appendQueryParameter
                    "q"
                    (queryValue (encodeQueryParamValue value))
                    defaultRequest
        buildFetchTargetURL (BaseUrl Https "example.com" 443 "") request
            === "https://example.com?q=" <> value
    it "reserved headers cannot leak from passthrough headers" $ do
        let request =
                defaultRequest
                    { requestHeaders =
                        Seq.fromList
                            [ ("accept", "wrong")
                            , ("CONTENT-TYPE", "wrong")
                            , ("X-Trace", "ok")
                            ]
                    }
            headers = requestHeadersToWorkersHeaders request
        headerLookup "Accept" headers `shouldBe` Nothing
        headerLookup "Content-Type" headers `shouldBe` Nothing
        headerLookup "x-trace" headers `shouldBe` Just "ok"
    it "derives authoritative Accept and Content-Type from request metadata" $ do
        let request =
                defaultRequest
                    { requestAccept = Seq.fromList ["application" // "json"]
                    , requestBody =
                        Just (RequestBodyLBS "{}", "application" // "json")
                    }
            headers = requestHeadersToWorkersHeaders request
        headerLookup "accept" headers `shouldBe` Just "application/json"
        headerLookup "content-type" headers `shouldBe` Just "application/json"

    it "escapes query names and preserves repeated keys in request order" $ do
        let request =
                appendQueryParameter "a&b" (queryValue "second") $
                    appendQueryParameter "a&b" (queryValue "first") defaultRequest
        buildFetchTargetURL (BaseUrl Https "example.com" 443 "") request
            `shouldBe` "https://example.com?a%26b=first&a%26b=second"
    partialEscapeQuerySpec
    it "uses metadata over conflicting headers and preserves multiple accepted types" $ do
        let request =
                defaultRequest
                    { requestHeaders =
                        Seq.fromList
                            [ ("Accept", "wrong")
                            , ("Content-Type", "wrong")
                            ]
                    , requestAccept =
                        Seq.fromList
                            [ "application" // "json"
                            , "text" // "plain"
                            ]
                    , requestBody =
                        Just
                            ( RequestBodyBS ""
                            , "application" // "octet-stream"
                            )
                    }
            headers = requestHeadersToWorkersHeaders request
        headerLookup "accept" headers
            `shouldBe` Just "application/json,text/plain"
        headerLookup "content-type" headers
            `shouldBe` Just "application/octet-stream"
    it "replaces malformed UTF-8 in header values without throwing" $ do
        let headers =
                requestHeadersToWorkersHeaders
                    defaultRequest
                        { requestHeaders = Seq.fromList [("X-Test", "\255")]
                        }
        headerLookup "x-test" headers `shouldBe` Just "\xfffd"

#if MIN_VERSION_servant_client_core(0,21,0)
partialEscapeQuerySpec :: Spec
partialEscapeQuerySpec =
    it "honours partially escaped query value sections" $ do
        let request =
                appendToQueryString
                    "filter"
                    [QE "a&b", QN "+language:haskell"]
                    defaultRequest
        buildFetchTargetURL (BaseUrl Https "example.com" 443 "") request
            `shouldBe` "https://example.com?filter=a%26b+language:haskell"
#else
partialEscapeQuerySpec :: Spec
partialEscapeQuerySpec = pure ()
#endif

#if MIN_VERSION_servant_client_core(0,21,0)
type QueryValue = [EscapeItem]

queryValue :: ByteString -> QueryValue
queryValue value = [QN value]

queryFlag :: QueryValue
queryFlag = []
#else
type QueryValue = Maybe ByteString

queryValue :: ByteString -> QueryValue
queryValue = Just

queryFlag :: QueryValue
queryFlag = Nothing
#endif

appendQueryParameter :: Text.Text -> QueryValue -> Request -> Request
appendQueryParameter = appendToQueryString

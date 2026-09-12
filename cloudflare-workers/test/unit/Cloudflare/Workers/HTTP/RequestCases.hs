module Cloudflare.Workers.HTTP.RequestCases (spec) where
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Cloudflare.Workers.URL
import Data.Maybe (isNothing)
import Data.IORef (readIORef)
import Support.Cloudflare.Workers.HTTP
import Hedgehog
import Support.Cloudflare.Workers.Generators
import Test.Syd
import Test.Syd.Hedgehog ()
spec :: Spec
spec = do
  it "recognizes every standard method case-sensitively" $ do
    map methodFromText ["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"]
      `shouldBe` [GET,POST,PUT,DELETE,PATCH,HEAD,OPTIONS]
    map methodToText [GET,POST,PUT,DELETE,PATCH,HEAD,OPTIONS] `shouldBe` ["GET","POST","PUT","DELETE","PATCH","HEAD","OPTIONS"]
    methodFromText "get" `shouldBe` OtherMethod "get"
  it "preserves arbitrary method text" $ property $ do
    value <- forAll unicodeText
    methodToText (methodFromText value) === value
  it "projects request fields and passes the body limit to its reader" $ do
    case parseURL "https://example.test/a%20b?q=1" of
      Nothing -> expectationFailure "fixture URL did not parse"
      Just url -> do
        (limits, reader) <- recordingBodyReader
        let headers = headersFromList [("content-type","text/plain")]
            request = Request POST url Nothing headers (Just reader) (Just "NRT")
        requestMethod request `shouldBe` POST
        requestURL request `shouldBe` url
        requestPath request `shouldBe` "/a b"
        isNothing (requestBody request) `shouldBe` True
        requestHeaders request `shouldBe` headers
        requestDataCenter request `shouldBe` Just "NRT"
        case requestBodyReader request of
          Nothing -> expectationFailure "body reader disappeared"
          Just runReader -> runReader 7 >>= (`shouldBe` Right "accepted")
        readIORef limits >>= (`shouldBe` [7])
        isNothing (requestBodyReader (request {requestBodyReaderField = Nothing})) `shouldBe` True
        requestDataCenter (request {requestDataCenterField = Nothing}) `shouldBe` Nothing
  it "sets the default byte limit to one MiB" $ defaultRequestBodyByteLimit `shouldBe` 1048576

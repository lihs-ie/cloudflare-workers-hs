module Cloudflare.Workers.HTTP.ResponseCases (spec) where
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Hedgehog
import Support.Cloudflare.Workers.Generators
import Test.Syd
import Test.Syd.Hedgehog ()
spec :: Spec
spec = do
  it "preserves strict binary bytes and metadata" $ property $ do
    bytes <- forAll byteString
    let headers = headersFromList [("x-result", "ok")]
        response = createResponse (Status 201) headers (ResponseBodyBytes bytes)
    responseStatus response === Status 201
    responseHeaders response === headers
    case responseBody response of
      ResponseBodyBytes actual -> actual === bytes
      _ -> failure
  it "preserves a lazy body" $ do
    let response = createResponse (Status 202) (headersFromList []) (ResponseBodyLazyBytes "lazy")
    statusCode (responseStatus response) `shouldBe` 202
    responseHeaders response `shouldBe` headersFromList []
    case responseBody response of
      ResponseBodyLazyBytes actual -> actual `shouldBe` "lazy"
      _ -> expectationFailure "lazy body changed constructor"

{-# LANGUAGE OverloadedStrings #-}
module Servant.Cloudflare.Workers.ErrorSpec (spec) where
import Test.Syd hiding (context)
import Test.Syd.Hedgehog ()
import Hedgehog (property, forAll, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import Data.ByteString.Lazy qualified as LBS
import Data.Aeson (decode, object, (.=))
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Servant.Cloudflare.Workers.Error
import Support.HTTP.Fixtures
spec :: Spec
spec = do
  it "keeps detail at the 512-character boundary" $
    serverErrorDetail (withDetail (Text.replicate 512 "あ") err400) `shouldBe` Just (Text.replicate 512 "あ")
  it "truncates overlong detail without splitting Unicode" $
    serverErrorDetail (withDetail (Text.replicate 513 "あ") err400) `shouldBe` Just (Text.replicate 512 "あ" <> "... (truncated)")
  it "preserves short generated details" $ property $ do
    detail <- forAll (Gen.text (Range.linear 0 512) Gen.unicode)
    serverErrorDetail (withDetail detail err400) === Just detail
  it "renders the documented JSON error envelope" $ do
    let response = serverErrorToResponse request (withDetail "invalid" err400)
    responseStatus response `shouldBe` Status 400
    headerLookup "Content-Type" (responseHeaders response) `shouldBe` Just "application/json;charset=utf-8"
    decode (bodyBytes response) `shouldBe` Just (object ["error" .= object ["status" .= (400::Int), "message" .= ("Bad Request"::Text.Text), "detail" .= ("invalid"::Text.Text)]])
  it "negotiates plain text including optional detail" $ do
    let req = request{requestHeaders=headersFromList [("Accept","text/plain")]}
    bodyBytes (serverErrorToResponse req err404) `shouldBe` "Not Found"
    bodyBytes (serverErrorToResponse req (withDetail "missing" err404)) `shouldBe` "Not Found: missing"
  it "falls back to JSON for unsupported Accept" $
    headerLookup "Content-Type" (responseHeaders (serverErrorToResponse request{requestHeaders=headersFromList [("Accept","image/png")]} err406)) `shouldBe` Just "application/json;charset=utf-8"
  it "preserves the complete independent error contract for generated details and negotiation" $ property $ do
    (err, code, message) <- forAll $ Gen.element
      [(err400,400,"Bad Request"),(err401,401,"Unauthorized"),(err404,404,"Not Found"),(err405,405,"Method Not Allowed"),(err406,406,"Not Acceptable"),(err413,413,"Payload Too Large"),(err415,415,"Unsupported Media Type"),(err500,500,"Internal Server Error")]
    detail <- forAll $ Gen.maybe (Gen.text (Range.linear 0 600) Gen.unicode)
    (accept, plain) <- forAll $ Gen.element
      [("application/json",False),("text/plain",True),("*/*",False),("image/png",False),("application/json;q=0.5,text/plain;q=1",True),("application/json;q=1,text/plain;q=0.5",False)]
    let req = request{requestHeaders=headersFromList [("Accept",accept)]}
        response = serverErrorToResponse req (maybe err (`withDetail` err) detail)
        renderedDetail = fmap (\d -> if Text.length d > 512 then Text.take 512 d <> "... (truncated)" else d) detail
    responseStatus response === Status code
    if plain
      then do
        headerLookup "Content-Type" (responseHeaders response) === Just "text/plain;charset=utf-8"
        bodyBytes response === LBS.fromStrict (TextEncoding.encodeUtf8 (message <> maybe "" (": " <>) renderedDetail))
      else do
        headerLookup "Content-Type" (responseHeaders response) === Just "application/json;charset=utf-8"
        decode (bodyBytes response) === Just (object ["error" .= object
          (["status" .= code, "message" .= message] <> maybe [] (\d -> ["detail" .= d]) renderedDetail)])
  it "preserves custom error headers" $
    headerLookup "X-Test" (responseHeaders (serverErrorToResponse request err401{serverErrorHeaders=[("X-Test","yes")]})) `shouldBe` Just "yes"
  describe "standard errors" $ mapM_ (\(err,code,message) -> it (show code) $ do
    serverErrorStatusCode err `shouldBe` code
    serverErrorMessage err `shouldBe` message
    serverErrorHeaders err `shouldBe` []
    serverErrorDetail err `shouldBe` Nothing)
    [(err400,400,"Bad Request"),(err401,401,"Unauthorized"),(err404,404,"Not Found"),(err405,405,"Method Not Allowed"),(err406,406,"Not Acceptable"),(err413,413,"Payload Too Large"),(err415,415,"Unsupported Media Type"),(err500,500,"Internal Server Error")]

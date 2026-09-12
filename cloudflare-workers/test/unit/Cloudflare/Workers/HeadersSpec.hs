module Cloudflare.Workers.HeadersSpec (spec) where
import Cloudflare.Workers.Headers
import Data.Text qualified as Text
import Hedgehog
import Support.Cloudflare.Workers.Generators
import Test.Syd
import Test.Syd.Hedgehog ()
spec :: Spec
spec = do
  it "empty headers distinguish absent lookup and no values" $ do
    headerLookup "missing" (headersFromList []) `shouldBe` Nothing
    headerLookupAll "missing" (headersFromList []) `shouldBe` []
    headersToList (headersFromList []) `shouldBe` []
  it "normalizes names and preserves repeated value order" $ do
    let headers = headersFromList [("X-Test", "first"), ("x-test", "second")]
    headerLookup "X-TEST" headers `shouldBe` Just "first"
    headerLookupAll "x-test" headers `shouldBe` ["first", "second"]
    headersToList headers `shouldBe` [("x-test", "first"), ("x-test", "second")]
  it "insert replaces all existing values while append retains them" $ property $ do
    first <- forAll unicodeText
    second <- forAll unicodeText
    let headers = headersFromList [("X-Test", first)]
    headerLookupAll "X-TEST" (headerAppend "x-test" second headers) === [first, second]
    headerLookupAll "X-TEST" (headerInsert "x-test" second headers) === [second]
  it "normalizes arbitrary names without changing values" $ property $ do
    name <- forAll unicodeText
    value <- forAll unicodeText
    headersToList (headersFromList [(name,value)]) === [(Text.toLower name,value)]
  it "compares normalized values and renders repeated headers in diagnostics" $ do
    let headers = headersFromList [("X-Test", "first"), ("x-test", "second")]
        normalized = headersFromList [("x-test", "first"), ("x-test", "second")]
        reversed = headersFromList [("x-test", "second"), ("x-test", "first")]
        rendered = "Headers (fromList [(\"x-test\",[\"first\",\"second\"])])"
    (headers /= normalized) `shouldBe` False
    (headers /= reversed) `shouldBe` True
    show headers `shouldBe` rendered
    showsPrec 11 headers "!" `shouldBe` "(" <> rendered <> ")!"
    showList [headers] "!" `shouldBe` "[" <> rendered <> "]!"

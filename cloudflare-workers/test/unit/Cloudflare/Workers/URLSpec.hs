module Cloudflare.Workers.URLSpec (spec) where
import Cloudflare.Workers.URL
import Hedgehog
import Support.Cloudflare.Workers.Generators
import Test.Syd
import Test.Syd.Hedgehog ()
spec :: Spec
spec = do
  it "rejects empty input" $ parseURL "" `shouldBe` Nothing
  it "normalizes relative and authority-only paths" $ do
    fmap urlPath (parseURL "relative") `shouldBe` Just "/relative"
    fmap urlPath (parseURL "https://example.test") `shouldBe` Just "/"
    fmap urlPath (parseURL "https://example.test?x=1") `shouldBe` Just "/"
    fmap urlPath (parseURL "/literal://path") `shouldBe` Just "/literal://path"
  it "retains raw path/query and distinguishes flags, empty and repeated values" $ do
    case parseURL "https://example.test/a%2Fb?flag&empty=&x=one&x=two&&plus=a+b#ignored" of
      Nothing -> expectationFailure "fixture URL did not parse"
      Just url -> do
        urlPath url `shouldBe` "/a/b"
        urlPathRaw url `shouldBe` "/a%2Fb"
        urlText url `shouldBe` "https://example.test/a%2Fb?flag&empty=&x=one&x=two&&plus=a+b"
        urlQueryStringVerbatim url `shouldBe` "flag&empty=&x=one&x=two&&plus=a+b"
        urlQueryParam "x" url `shouldBe` Just "one"
        urlQueryParams "x" url `shouldBe` ["one","two"]
        urlQueryParamPresence "flag" url `shouldBe` Just Nothing
        urlQueryParamPresence "empty" url `shouldBe` Just (Just "")
        urlQueryParamPresence "missing" url `shouldBe` Nothing
        urlQueryParam "missing" url `shouldBe` Nothing
        urlQueryParams "missing" url `shouldBe` []
        urlQueryParamOccurrences "x" url `shouldBe` [Just "one",Just "two"]
        urlQueryParamOccurrences "missing" url `shouldBe` []
        urlQueryParam "flag" url `shouldBe` Just ""
        urlQueryParams "flag" url `shouldBe` [""]
        urlQueryParam "plus" url `shouldBe` Just "a+b"
        urlQueryRaw url `shouldBe` "empty=&flag&plus=a%2Bb&x=one&x=two"
    fmap urlQueryRaw (parseURL "/") `shouldBe` Just ""
  it "encodes known UTF-8 and reserved characters" $ do
    percentEncodeQueryComponent "AZaz09-._~ /+日本" `shouldBe` "AZaz09-._~%20%2F%2B%E6%97%A5%E6%9C%AC"
    percentDecode "%41%4a%4F%aF" `shouldBe` "AJO\xfffd"
    percentDecode "%GG%0g%g0%a%" `shouldBe` "%GG%0g%g0%a%"
  it "round-trips Unicode through percent encoding" $ property $ do
    value <- forAll unicodeText
    percentDecode (percentEncodeQueryComponent value) === value
  it "preserves flag and empty query distinctions in identity and diagnostics" $ do
    case (parseURL "/?flag&empty=", parseURL "/?flag=&empty=") of
      (Just flagged, Just explicitEmpty) -> do
        (flagged /= flagged) `shouldBe` False
        (flagged /= explicitEmpty) `shouldBe` True
        let rendered = "URL {urlTextField = \"/?flag&empty=\", urlPathField = \"/\", urlPathRawField = \"/\", urlQueryStringVerbatimField = \"flag&empty=\", urlQueryParametersField = fromList [(\"empty\",[Just \"\"]),(\"flag\",[Nothing])]}"
        show flagged `shouldBe` rendered
        showsPrec 11 flagged "!" `shouldBe` "(" <> rendered <> ")!"
        showList [flagged] "!" `shouldBe` "[" <> rendered <> "]!"
      _ -> expectationFailure "query diagnostic fixtures did not parse"

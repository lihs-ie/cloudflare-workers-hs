module Cloudflare.Workers.Binding.D1.QuerySpec (spec) where

import Cloudflare.Workers.Binding.D1
import Cloudflare.Workers.Binding.D1.Query
import Cloudflare.Workers.HostTestKit (phantomJSVal)
import Control.Exception (try)
import Control.Monad (void)
import Data.Text qualified as Text
import Hedgehog (forAll, property, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Test.Syd
import Test.Syd.Hedgehog ()

spec :: Spec
spec = describe "typed D1 rows and parameters" $ do
    it "composes named columns independently of projection order" $ property $ do
        name <- forAll (Gen.text (Range.linear 0 100) Gen.unicode)
        count <- forAll (Gen.integral (Range.linear (-1000000) 1000000))
        let decoder = (,) <$> d1Column "name" d1Text <*> d1Column "count" d1Integer
        decodeD1Row decoder [("ignored", D1Null), ("count", D1Integer count), ("name", D1Text name)] === Right (name, count)
    it "distinguishes missing, SQL NULL, and wrong type" $ do
        let decoder = d1Column "name" d1Text
        decodeD1Row decoder [] `shouldBe` Left (D1MissingColumn "name")
        decodeD1Row decoder [("name", D1Null)] `shouldBe` Left (D1UnexpectedNull "name")
        decodeD1Row decoder [("name", D1Integer 4)] `shouldBe` Left (D1ColumnTypeMismatch "name" D1TextType D1IntegerType)
    it "nullable permits NULL but still rejects a missing or mistyped column" $ do
        let decoder = d1Column "optional" (d1Nullable d1Text)
        decodeD1Row decoder [("optional", D1Null)] `shouldBe` Right Nothing
        decodeD1Row decoder [("optional", D1Text "value")] `shouldBe` Right (Just "value")
        decodeD1Row decoder [] `shouldBe` Left (D1MissingColumn "optional")
        decodeD1Row decoder [("optional", D1Blob "binary")] `shouldBe` Left (D1ColumnTypeMismatch "optional" D1TextType D1BlobType)
    it "accepts integer and real numeric representations without unsafe conversion" $ do
        let decoder = d1Column "number" d1Double
        decodeD1Row decoder [("number", D1Integer 1)] `shouldBe` Right 1
        decodeD1Row decoder [("number", D1Real 1.25)] `shouldBe` Right 1.25
        decodeD1Row decoder [("number", D1Integer 9007199254740992)] `shouldBe` Left (D1InvalidColumnValue "number" "integer exceeds exact JavaScript numeric range")
        decodeD1Row decoder [("number", D1Real (1 / 0))] `shouldBe` Left (D1InvalidColumnValue "number" "non-finite numeric value")
        decodeD1Row decoder [("number", D1Real (0 / 0))] `shouldBe` Left (D1InvalidColumnValue "number" "non-finite numeric value")
    it "rejects unsafe native integers instead of accepting already-rounded data" $ do
        decodeD1Row (d1Column "number" d1Integer) [("number", D1Integer 9007199254740991)] `shouldBe` Right 9007199254740991
        decodeD1Row (d1Column "number" d1Integer) [("number", D1Integer 9007199254740992)] `shouldBe` Left (D1InvalidColumnValue "number" "integer exceeds exact JavaScript numeric range")
    it "decodes binary data and strictly stored booleans" $ do
        decodeD1Row (d1Column "bytes" d1Blob) [("bytes", D1Blob "\NUL\255")] `shouldBe` Right "\NUL\255"
        map (\value -> decodeD1Row (d1Column "flag" d1Bool) [("flag", D1Integer value)]) [0, 1, 2]
            `shouldBe` [Right False, Right True, Left (D1InvalidColumnValue "flag" "boolean must be stored as integer 0 or 1")]
    it "keeps bounded integer decoding explicit" $ do
        decodeD1Row (d1Column "count" d1BoundedInt) [("count", D1Integer 2147483647)] `shouldBe` Right 2147483647
        decodeD1Row (d1Column "count" d1BoundedInt) [("count", D1Text "3")] `shouldBe` Left (D1ColumnTypeMismatch "count" D1IntegerType D1TextType)
    it "refines a decoded field without leaking its rejected contents" $ do
        let decoder = d1Column "secret" (d1Refine (\value -> if Text.length value >= 8 then Right value else Left "too short") d1Text)
        decodeD1Row decoder [("secret", D1Text "private")] `shouldBe` Left (D1InvalidColumnValue "secret" "too short")
        decodeD1Row decoder [("secret", D1Text "accepted")] `shouldBe` Right "accepted"
    it "supports a dependent decoder selected by a discriminator" $ do
        let decoder = do
                kind <- d1Column "kind" d1Text
                if kind == "text" then d1Column "text" d1Text else Text.pack . show <$> d1Column "number" d1Integer
        decodeD1Row decoder [("kind", D1Text "number"), ("number", D1Integer 7)] `shouldBe` Right "7"
        decodeD1Row decoder [("kind", D1Text "text"), ("text", D1Text "hello")] `shouldBe` Right "hello"
    it "reports the first bad result row using a one-based index" $ do
        decodeD1Rows (d1Column "count" d1Integer) [[("count", D1Integer 1)], [("count", D1Null)]]
            `shouldBe` Left (D1RowDecodeFailed 2 (D1UnexpectedNull "count"))
        decodeD1Rows (d1Column "count" d1Integer) [] `shouldBe` Right []
    it "throws a typed decoding exception for an explicitly decoded raw row" $ do
        result <- try @D1DecodeError (decodeD1RowOrThrow (d1Column "name" d1Text) [])
        result `shouldBe` Left (D1MissingColumn "name")
    it "rejects unsafe bound values before touching an invalid native database handle" $ do
        let database = D1 phantomJSVal
        result <- try @D1QueryError (void (d1PrepareQuery database (D1Statement "SELECT ?" [D1Integer 9007199254740993])))
        result `shouldBe` Left (D1InvalidParameter 1 "integer exceeds exact JavaScript numeric range")
        validateD1Statement (D1Statement "SELECT ?, ?" [D1Text "valid", D1Real (1 / 0)])
            `shouldBe` Left (D1InvalidParameter 2 "non-finite numeric value")
        validateD1Statement (D1Statement "SELECT ?" [D1Integer 9007199254740991]) `shouldBe` Right ()
    it "treats an empty batch as no work without touching native bindings" $
        d1ExecuteBatch (D1 phantomJSVal) [] `shouldReturn` []
    it "preserves signed safe-integer boundaries and rejects both successors" $ do
        let decoder = d1Column "value" d1Integer
        map (\value -> decodeD1Row decoder [("value", D1Integer value)]) [-9007199254740991, 9007199254740991]
            `shouldBe` [Right (-9007199254740991), Right 9007199254740991]
        map (\value -> decodeD1Row decoder [("value", D1Integer value)]) [-9007199254740992, 9007199254740992]
            `shouldBe` replicate 2 (Left (D1InvalidColumnValue "value" "integer exceeds exact JavaScript numeric range"))
    it "keeps raw rows explicit and maps nullable values without swallowing errors" $ do
        let row = [("value", D1Blob "raw")]
        decodeD1Row d1RawRow row `shouldBe` Right row
        decodeD1Row (pure "constant") row `shouldBe` Right ("constant" :: Text.Text)
        decodeD1Row (d1Column "value" (Text.length <$> d1Text)) [("value", D1Text "abc")] `shouldBe` Right 3
        decodeD1Row (d1Column "value" d1Double) row `shouldBe` Left (D1ColumnTypeMismatch "value" D1RealType D1BlobType)
        decodeD1Row (d1Column "value" d1Blob) [("value", D1Real 1)] `shouldBe` Left (D1ColumnTypeMismatch "value" D1BlobType D1RealType)
    it "remains usable after an explicitly thrown decoding failure" $ do
        failure <- try @D1DecodeError (decodeD1RowOrThrow (d1Column "value" d1Integer) [])
        failure `shouldBe` Left (D1MissingColumn "value")
        decodeD1RowOrThrow (d1Column "value" d1Integer) [("value", D1Integer 42)] `shouldReturn` 42

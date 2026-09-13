{-# LANGUAGE DeriveGeneric #-}
module WorkflowExample.DomainSpec (spec) where
import WorkflowExample.Domain
import Data.Aeson
import GHC.Generics (Generic)
import GHC.Generics qualified as Generic
import Data.List (nub, isInfixOf)
import Data.Either (isLeft)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Time
import Test.Syd

spec :: Spec
spec = do
  let decodeAt :: Value -> Result ApprovalRequest
      decodeAt stamp = fromJSON (object ["message" .= ("hello" :: Text), "behavior" .= ("approve" :: Text), "executeAt" .= stamp])
      expected = UTCTime (fromGregorian 2024 2 29) 0
  it "accepts canonical UTC dates and preserves subsecond precision" $ do
    decodeAt (String "2024-02-29T00:00:00Z") `shouldBe` Success (ApprovalRequest "hello" "approve" (Just expected))
    decodeAt (String "2024-02-29T00:00:00.125Z") `shouldBe` Success (ApprovalRequest "hello" "approve" (Just (addUTCTime 0.125 expected)))
  it "rejects invalid calendar dates, nonUTC offsets, whitespace and wrong JSON types" $
    mapM_ (\stamp -> case decodeAt stamp of
      Error _ -> pure ()
      Success value -> expectationFailure (show value))
      [String "2023-02-29T00:00:00Z", String "2024-02-29T00:00:00+00:00", String "2024-02-29", String "2024-02-29T00:00:00Z ", String "2024-02-29T00:00:00z", Number 1, Bool True]
  it "rejects parser-normalized surrounding whitespace rather than silently changing the schedule input" $ do
    -- Data.Time permits this whitespace. These assertions distinguish the
    -- application's canonical representation checks from parser rejection.
    mapM_ (\timestamp -> do
      (parseTimeM True defaultTimeLocale "%Y-%m-%dT%H:%M:%S%QZ" timestamp :: Maybe UTCTime) `shouldBe` Just expected
      case decodeAt (String (Text.pack timestamp)) of
        Error _ -> pure ()
        Success value -> expectationFailure ("noncanonical schedule accepted: " <> show value))
      [" 2024-02-29T00:00:00Z", "2024-02-29T00:00:00Z "]
  it "allows omitted or null schedule without inventing a date" $ do
    decodeAt Null `shouldBe` Success (ApprovalRequest "hello" "approve" Nothing)
    (fromJSON (object ["message" .= ("hello" :: Text),"behavior" .= ("approve" :: Text)]) :: Result ApprovalRequest) `shouldBe` Success (ApprovalRequest "hello" "approve" Nothing)
  it "roundtrips the complete creation contract and both approval decisions" $ do
    let request = CreateRequest "stable-key" (ApprovalRequest "hello" "approve" (Just expected))
    eitherDecode (encode request) `shouldBe` Right request
    mapM_ (\accepted -> eitherDecode (encode (Approval accepted)) `shouldBe` Right (Approval accepted)) [False,True]
  it "rejects incomplete creation and mistyped approval payloads" $ do
    case (fromJSON (object []) :: Result CreateRequest) of
      Error _ -> pure ()
      Success _ -> expectationFailure "missing creation fields accepted"
    case (fromJSON (object ["approved" .= ("yes" :: Text)]) :: Result Approval) of
      Error _ -> pure ()
      Success _ -> expectationFailure "nonboolean approval accepted"

  it "decodes a queued request for the workflow scheduler and approval consumer" $ do
    case (eitherDecode "{\"identifier\":\"scheduled-job\",\"parameters\":{\"message\":\"hello\",\"behavior\":\"approve\",\"executeAt\":\"2024-02-29T00:00:00Z\"}}" :: Either String CreateRequest) of
      Left failure -> expectationFailure failure
      Right request -> do
        identifier request `shouldBe` "scheduled-job"
        message (parameters request) `shouldBe` "hello"
        behavior (parameters request) `shouldBe` "approve"
        executeAt (parameters request) `shouldBe` Just expected
    fmap approved (eitherDecode "{\"approved\":false}") `shouldBe` Right False
  it "supports downstream change detection and diagnostic batch identity" $ do
    let first = ApprovalRequest "first" "approve" Nothing
        second = ApprovalRequest "second" "approve" Nothing
    diagnosticContract "ApprovalRequest" first second
    diagnosticContract "CreateRequest" (CreateRequest "first" first) (CreateRequest "second" first)
    diagnosticContract "Approval" (Approval True) (Approval False)
  it "returns useful schema and scheduling errors to a request form consumer" $ do
    case (eitherDecode "[]" :: Either String ApprovalRequest) of
      Left failure -> "ApprovalRequest" `isInfixOf` failure `shouldBe` True
      Right value -> expectationFailure (show value)
    case decodeAt (String "invalid") of
      Error failure -> "executeAt must be a valid UTC RFC3339 timestamp ending in Z" `isInfixOf` failure `shouldBe` True
      Success value -> expectationFailure (show value)
  it "matches the documented nested wire schema for scheduled and unscheduled requests" $ do
    let unscheduled = ApprovalRequest "hello" "approve" Nothing
        scheduled = ApprovalRequest "later" "approve" (Just (addUTCTime 0.125 expected))
        unscheduledJSON = object ["message" .= ("hello" :: Text), "behavior" .= ("approve" :: Text), "executeAt" .= Null]
        scheduledJSON = object ["message" .= ("later" :: Text), "behavior" .= ("approve" :: Text), "executeAt" .= ("2024-02-29T00:00:00.125Z" :: Text)]
        requests = [CreateRequest "now" unscheduled, CreateRequest "later" scheduled]
    wireContract unscheduled unscheduledJSON
    wireContract scheduled scheduledJSON
    wireContract (head requests) (object ["identifier" .= ("now" :: Text), "parameters" .= unscheduledJSON])
    wireContract (Approval False) (object ["approved" .= False])
    wireContract (Approval True) (object ["approved" .= True])
    eitherDecode (encode requests) `shouldBe` Right requests
    eitherDecode (encode [unscheduled, scheduled]) `shouldBe` Right [unscheduled, scheduled]
    eitherDecode (encode [Approval False, Approval True]) `shouldBe` Right [Approval False, Approval True]
  it "rejects wrong container types, absent nested fields and trailing timestamp junk" $ do
    map (\payload -> isLeft (eitherDecode payload :: Either String ApprovalRequest))
      ["[]", "null", "{}", "{\"message\":1,\"behavior\":\"approve\"}", "{\"message\":\"ok\"}"] `shouldBe` replicate 5 True
    map (\payload -> isLeft (eitherDecode payload :: Either String CreateRequest))
      ["[]", "{\"identifier\":1,\"parameters\":{}}", "{\"identifier\":\"x\",\"parameters\":null}"] `shouldBe` replicate 3 True
    map (\payload -> isLeft (eitherDecode payload :: Either String Approval))
      ["false", "{}", "{\"approved\":null}"] `shouldBe` replicate 3 True
    mapM_ (\stamp -> case decodeAt (String stamp) of
      Error _ -> pure ()
      Success value -> expectationFailure ("invalid timestamp accepted: " <> show value))
      ["2024-02-29T00:00:00Zjunk", "2024-02-29 00:00:00Z", "2024-02-29t00:00:00Z"]

wireContract :: (Eq a, Show a, FromJSON a, ToJSON a, Generic a) => a -> Value -> IO ()
wireContract value expected = do
  let reconstructed = Generic.to (Generic.from value) `asTypeOf` value
  toJSON reconstructed `shouldBe` expected
  toJSON value `shouldBe` expected
  eitherDecode (encode value) `shouldBe` Right expected
  eitherDecode (encode expected) `shouldBe` Right value
  toJSON [value] `shouldBe` toJSON [expected]
  eitherDecode (encode [value]) `shouldBe` Right [expected]
  toJSON (Envelope value) `shouldBe` object ["payload" .= expected]
  eitherDecode (encode (Envelope value)) `shouldBe` Right (object ["payload" .= expected])
  decode (encode (object [])) `shouldBe` (Nothing `asTypeOf` Just (Envelope value))

-- Test-only downstream envelope: payload is required even when optional fields
-- elsewhere in the enclosing protocol are omitted.
data Envelope a = Envelope {payload :: a} deriving (Eq, Show, Generic)
instance ToJSON a => ToJSON (Envelope a) where
    toJSON = genericToJSON defaultOptions {omitNothingFields = True}
    toEncoding = genericToEncoding defaultOptions {omitNothingFields = True}
instance FromJSON a => FromJSON (Envelope a)

-- A diagnostic consumer must preserve identity, delimit lists, and append the
-- caller's suffix. This is a downstream contract, not a production logging claim.
diagnosticContract :: (Eq a, Show a) => String -> a -> a -> IO ()
diagnosticContract constructor original changed = do
    original /= changed `shouldBe` True
    nub [original, original, changed] `shouldBe` [original, changed]
    let scalar = show original
    constructor `isInfixOf` scalar `shouldBe` True
    show original /= show changed `shouldBe` True
    showList [original, changed] "suffix" `shouldBe` "[" <> scalar <> "," <> show changed <> "]suffix"
    showsPrec 11 original "suffix" `shouldBe` "(" <> scalar <> ")suffix"

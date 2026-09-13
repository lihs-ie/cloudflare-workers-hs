{-# LANGUAGE DataKinds #-}
{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE TypeApplications #-}

module URLShortener.DomainSpec (spec) where

import Data.Aeson
import Data.Either (isLeft, isRight)
import Data.List (isInfixOf, nub)
import Data.Text qualified as T
import Data.Time (addDays, addUTCTime, fromGregorian)
import GHC.Generics (Generic)
import GHC.Generics qualified as Generic
import GHC.Records (getField)
import Hedgehog qualified as H
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Support.DomainFixtures (epoch)
import Test.Syd
import Test.Syd.Hedgehog ()
import URLShortener.Domain

spec :: Spec
spec = do
    describe "destination validation" $ do
        it "accepts public DNS HTTP and HTTPS URLs" $
            map (isRight . validateDestination) ["https://example.com/a?q=x#part", "http://api.example.com:8080/"] `shouldBe` [True, True]
        it "rejects credentials, local addresses, numeric hosts and malformed URLs" $
            map
                (isLeft . validateDestination)
                ["javascript:alert(1)", "https://user:pass@example.com", "http://localhost", "http://127.0.0.1", "http://[::1]", "http://2130706433", "http://service.local", "https://example.com:0", "https://example.com:65536", "https://example.com/ a", "//example.com", "https://a..com"]
                `shouldBe` replicate 12 True
        it "accepts generated public DNS labels without altering destinations" $ H.property $ do
            label <- H.forAll (Gen.text (Range.linear 1 40) Gen.lower)
            let target = "https://" <> label <> ".example.com/path"
            validateDestination target H.=== Right target
        it "accepts public IPv4 and IPv6 literals" $
            map
                (isRight . validateDestination)
                ["https://1.1.1.1", "http://8.8.8.8:8080/a", "https://[2606:4700:4700::1111]", "https://[2001:4860:4860::8888]"]
                `shouldBe` replicate 4 True
        it "rejects private, reserved and alternative numeric IP forms" $
            map
                (isLeft . validateDestination)
                [ "http://10.0.0.1"
                , "http://172.16.0.1"
                , "http://192.168.0.1"
                , "http://169.254.169.254"
                , "http://100.64.0.1"
                , "http://192.0.2.1"
                , "http://198.18.0.1"
                , "http://224.0.0.1"
                , "http://127.1"
                , "http://0177.0.0.1"
                , "http://0x7f000001"
                , "http://127.0.0.0x1"
                , "http://[::ffff:127.0.0.1]"
                , "http://[fc00::1]"
                , "http://[fe80::1]"
                , "http://[2001:db8::1]"
                , "http://[3fff::1]"
                ]
                `shouldBe` replicate 17 True
    describe "UTC date range" $ do
        it "includes both endpoints and accepts a leap year" $
            isRight (mkDateRange (fromGregorian 2024 1 1) (fromGregorian 2024 12 31)) `shouldBe` True
        it "rejects reverse ranges" $
            mkDateRange (fromGregorian 2026 1 2) (fromGregorian 2026 1 1) `shouldBe` Left "end date precedes start date"
        it "enforces 366 inclusive days for generated lengths" $ H.property $ do
            count <- H.forAll (Gen.integral (Range.linear 1 800))
            let start = fromGregorian 2026 1 1
            isRight (mkDateRange start (addDays (count - 1) start)) H.=== (count <= 366)
    describe "retention and URL validity" $ do
        it "expires idempotency and exports after seven days" $ do
            idempotencyExpiresAt epoch `shouldBe` addUTCTime 604800 epoch
            exportExpiresAt epoch `shouldBe` addUTCTime 604800 epoch
        it "accepts late events before but never at the thirty day deadline" $ do
            let event = ClickEvent "event" "url" epoch
            eventWithinWindow (addUTCTime (-1) epoch) event `shouldBe` False
            eventWithinWindow epoch event `shouldBe` True
            eventWithinWindow (addUTCTime (-1) (eventExpiresAt epoch)) event `shouldBe` True
            eventWithinWindow (eventExpiresAt epoch) event `shouldBe` False
        it "does not redirect tombstones or expired URLs" $ do
            let target = ShortURL "code" "https://example.com" epoch Nothing Nothing 1
            isRedirectable epoch target `shouldBe` True
            isRedirectable epoch (target{deletedAt = Just epoch}) `shouldBe` False
            isRedirectable epoch (ShortURL "code" "https://example.com" epoch (Just epoch) Nothing 1) `shouldBe` False
        it "requires future expiry and a positive edit version" $ do
            isLeft (validateCreateURL epoch (CreateURL "https://example.com" (Just epoch))) `shouldBe` True
            isLeft (validateEditURL epoch (EditURL "https://example.com" Nothing 0)) `shouldBe` True
            isRight (validateEditURL epoch (EditURL "https://example.com" Nothing 1)) `shouldBe` True
        it "round trips event wire contracts" $ H.property $ do
            number <- H.forAll (Gen.integral (Range.linear 0 (100000 :: Int)))
            let event = ClickEvent (T.pack (show number)) "url" (addUTCTime (fromIntegral number) epoch)
            decode (encode event) H.=== Just event

    describe "public destination boundary contracts" $ do
        it "preserves valid port limits and full IPv6 encodings" $ do
            let targets =
                    [ "https://example.com:1"
                    , "https://example.com:65535"
                    , "https://[2606:4700:4700:0:0:0:0:1111]"
                    , "https://[64:ff9b::8.8.8.8]"
                    , "https://192.0.0.9"
                    , "https://192.0.0.10"
                    , "https://a1-b.example.com"
                    ]
            map validateDestination targets `shouldBe` map Right targets
        it "rejects malformed ports and noncanonical numeric addresses" $ do
            let targets =
                    [ "https://example.com:"
                    , "https://example.com:000001"
                    , "https://example.com:-1"
                    , "https://example.com:abc"
                    , "http://1.2.3.256"
                    , "http://1.2.3.0001"
                    , "http://1.2.3."
                    , "http://1.2.3.04"
                    , "http://1.2.3.0x4"
                    , "http://[2606:4700:4700:0:0:0:1111]"
                    , "http://[2606::4700::1111]"
                    , "http://[2606:12345::1]"
                    , "http://[2606:zzzz::1]"
                    , "http://[2606:1:2:3:4:5:6:7::8]"
                    ]
            map (isLeft . validateDestination) targets `shouldBe` replicate (length targets) True
        it "enforces DNS label syntax and the whole hostname length" $ do
            let longest = T.intercalate "." [T.replicate 63 "a", T.replicate 63 "b", T.replicate 63 "c", T.replicate 61 "d"]
                valid = "https://" <> longest
                invalid =
                    [ "https://-a.example.com"
                    , "https://a-.example.com"
                    , "https://a_b.example.com"
                    , "https://" <> T.replicate 64 "a" <> ".com"
                    , "https://" <> longest <> "d"
                    , "https://a.123"
                    , "https://example.home.arpa"
                    , "https://example.onion"
                    ]
            validateDestination valid `shouldBe` Right valid
            map (isLeft . validateDestination) invalid `shouldBe` replicate (length invalid) True
        it "checks adjacent public and reserved IPv4 network boundaries" $ do
            let allowed = ["100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "223.255.255.255"]
                denied = ["100.64.0.0", "100.127.255.255", "172.16.0.0", "172.31.255.255", "224.0.0.0", "192.0.0.8", "192.0.0.11"]
            map (isRight . validateDestination . ("http://" <>)) allowed `shouldBe` replicate (length allowed) True
            map (isLeft . validateDestination . ("http://" <>)) denied `shouldBe` replicate (length denied) True
    describe "URI parser handoff boundaries" $ do
        it "rejects four-label numeric-like DNS names with a nondigit octet" $
            validateDestination "https://a.1.2.3" `shouldBe` Left "destination must be an HTTP(S) URL with a public hostname or IP address and no credentials"
        it "rejects URI-valid IPvFuture and scoped IPv6 literals outside the destination policy" $ do
            map validateDestination ["https://[v1.a]", "https://[2606:4700::1111%25eth0]"]
                `shouldBe` replicate 2 (Left "destination must be an HTTP(S) URL with a public hostname or IP address and no credentials")
    describe "exact domain boundaries" $ do
        it "returns actionable rejection text to a destination form consumer" $
            validateDestination "javascript:alert(1)" `shouldBe` Left "destination must be an HTTP(S) URL with a public hostname or IP address and no credentials"

        it "returns inclusive date endpoints at one and 366 days and rejects 367" $ do
            let start = fromGregorian 2024 1 1
            fmap (\value -> (rangeStart value, rangeEnd value)) (mkDateRange start start) `shouldBe` Right (start, start)
            fmap (\value -> (rangeStart value, rangeEnd value)) (mkDateRange start (addDays 365 start)) `shouldBe` Right (start, addDays 365 start)
            mkDateRange start (addDays 366 start) `shouldBe` Left "date range exceeds 366 days"
        it "returns validated create/edit payloads and rejects past expiries" $ do
            let create = CreateURL "https://example.com" (Just (addUTCTime 1 epoch))
                edit = EditURL "https://example.com" (Just (addUTCTime 1 epoch)) 1
            validateCreateURL epoch create `shouldBe` Right create
            validateCreateURL epoch (CreateURL "https://example.com" Nothing) `shouldBe` Right (CreateURL "https://example.com" Nothing)
            validateEditURL epoch edit `shouldBe` Right edit
            validateCreateURL epoch (CreateURL "https://example.com" (Just (addUTCTime (-1) epoch))) `shouldBe` Left "expiry must be in the future"
            validateEditURL epoch (EditURL "https://example.com" (Just epoch) 1) `shouldBe` Left "expiry must be in the future"
            validateEditURL epoch (EditURL "https://example.com" Nothing (-1)) `shouldBe` Left "version must be positive"
            isLeft (validateCreateURL epoch (CreateURL "invalid" Nothing)) `shouldBe` True
            isLeft (validateEditURL epoch (EditURL "invalid" Nothing 1)) `shouldBe` True
        it "rejects future-created URLs and accepts not-yet-expired live URLs" $ do
            isRedirectable epoch (ShortURL "code" "https://example.com" (addUTCTime 1 epoch) Nothing Nothing 1) `shouldBe` False
            isRedirectable epoch (ShortURL "code" "https://example.com" epoch (Just (addUTCTime 1 epoch)) Nothing 1) `shouldBe` True

    describe "public JSON consumer contracts" $ do
        it "supports downstream batch change detection and identifiable diagnostic lists" $ do
            diagnosticContract "CreateURL" (CreateURL "https://example.com" Nothing) (CreateURL "https://example.org" Nothing)
            diagnosticContract "EditURL" (EditURL "https://example.com" Nothing 1) (EditURL "https://example.com" Nothing 2)
            diagnosticContract "ShortURL" (ShortURL "first" "https://example.com" epoch Nothing Nothing 1) (ShortURL "second" "https://example.com" epoch Nothing Nothing 1)
            diagnosticContract "ClickEvent" (ClickEvent "first" "url" epoch) (ClickEvent "second" "url" epoch)
            case (mkDateRange (fromGregorian 2024 1 1) (fromGregorian 2024 1 1), mkDateRange (fromGregorian 2024 1 1) (fromGregorian 2024 1 2)) of
                (Right first, Right second) -> diagnosticContract "DateRange" first second
                other -> expectationFailure (show other)

        it "consumes decoded URL records for management forms and click attribution" $ do
            let create = CreateURL "https://example.com" Nothing
                edit = EditURL "https://example.com/new" (Just epoch) 2
                urlValue = ShortURL "code" "https://example.com" epoch Nothing (Just epoch) 3
                click = ClickEvent "event" "code" epoch
            fmap (\value -> (getField @"destination" value, getField @"expiresAt" value)) (decode (encode create) :: Maybe CreateURL)
                `shouldBe` Just ("https://example.com", Nothing)
            fmap (\value -> (getField @"destination" value, getField @"expiresAt" value, getField @"version" value)) (decode (encode edit) :: Maybe EditURL)
                `shouldBe` Just ("https://example.com/new", Just epoch, 2)
            fmap (\value -> (getField @"identifier" value, getField @"destination" value, getField @"createdAt" value, getField @"expiresAt" value, getField @"deletedAt" value, getField @"version" value)) (decode (encode urlValue) :: Maybe ShortURL)
                `shouldBe` Just ("code", "https://example.com", epoch, Nothing, Just epoch, 3)
            fmap (\value -> (getField @"identifier" value, getField @"url" value, getField @"occurredAt" value)) (decode (encode click) :: Maybe ClickEvent)
                `shouldBe` Just ("event", "code", epoch)

        it "preserves create and edit payloads on the wire, including absent expiry" $ do
            wireContract
                (CreateURL "https://example.com" Nothing)
                (object ["destination" .= ("https://example.com" :: T.Text), "expiresAt" .= (Nothing :: Maybe T.Text)])
            wireContract
                (EditURL "https://example.com" (Just epoch) 7)
                (object ["destination" .= ("https://example.com" :: T.Text), "expiresAt" .= epoch, "version" .= (7 :: Int)])
            eitherDecode "{\"destination\":\"https://example.com\"}"
                `shouldBe` Right (CreateURL "https://example.com" Nothing)
            eitherDecode "{\"destination\":\"https://example.com\",\"version\":7}"
                `shouldBe` Right (EditURL "https://example.com" Nothing 7)
        it "preserves list responses, tombstones and fractional event timestamps" $ do
            let live = ShortURL "live" "https://example.com" epoch Nothing Nothing 1
                removed = ShortURL "removed" "https://example.com/old" epoch (Just epoch) (Just epoch) 2
                event = ClickEvent "click" "live" (addUTCTime 0.125 epoch)
                urlJSON code target expiry deleted revision =
                    object
                        [ "identifier" .= (code :: T.Text)
                        , "destination" .= (target :: T.Text)
                        , "createdAt" .= epoch
                        , "expiresAt" .= (expiry :: Maybe T.Text)
                        , "deletedAt" .= (deleted :: Maybe T.Text)
                        , "version" .= (revision :: Int)
                        ]
            wireContract live (urlJSON "live" "https://example.com" Nothing Nothing 1)
            wireContract
                removed
                ( object
                    [ "identifier" .= ("removed" :: T.Text)
                    , "destination" .= ("https://example.com/old" :: T.Text)
                    , "createdAt" .= epoch
                    , "expiresAt" .= epoch
                    , "deletedAt" .= epoch
                    , "version" .= (2 :: Int)
                    ]
                )
            wireContract event (object ["identifier" .= ("click" :: T.Text), "url" .= ("live" :: T.Text), "occurredAt" .= addUTCTime 0.125 epoch])
            eitherDecode (encode [live, removed]) `shouldBe` Right [live, removed]
            eitherDecode (encode [event]) `shouldBe` Right [event]
            eitherDecode (encode [CreateURL "https://example.com" Nothing]) `shouldBe` Right [CreateURL "https://example.com" Nothing]
            eitherDecode (encode [EditURL "https://example.com" Nothing 1]) `shouldBe` Right [EditURL "https://example.com" Nothing 1]
        it "rejects missing required fields and invalid field types before validation" $ do
            map
                (\payload -> isLeft (eitherDecode payload :: Either String CreateURL))
                ["{}", "{\"destination\":1}", "{\"destination\":\"https://example.com\",\"expiresAt\":false}"]
                `shouldBe` replicate 3 True
            map
                (\payload -> isLeft (eitherDecode payload :: Either String EditURL))
                ["{\"destination\":\"https://example.com\"}", "{\"destination\":\"https://example.com\",\"version\":\"1\"}"]
                `shouldBe` replicate 2 True
            map
                (\payload -> isLeft (eitherDecode payload :: Either String ShortURL))
                ["{}", "{\"identifier\":\"a\",\"destination\":\"https://example.com\",\"createdAt\":\"bad-date\",\"version\":1}"]
                `shouldBe` replicate 2 True
            map
                (\payload -> isLeft (eitherDecode payload :: Either String ClickEvent))
                ["{}", "{\"identifier\":\"a\",\"url\":false,\"occurredAt\":\"2024-02-29T00:00:00Z\"}"]
                `shouldBe` replicate 2 True

-- Compare both encoding entry points against a consumer-visible schema.
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
newtype Envelope a = Envelope {payload :: a} deriving (Eq, Show, Generic)
instance (ToJSON a) => ToJSON (Envelope a) where
    toJSON = genericToJSON defaultOptions{omitNothingFields = True}
    toEncoding = genericToEncoding defaultOptions{omitNothingFields = True}
instance (FromJSON a) => FromJSON (Envelope a)

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

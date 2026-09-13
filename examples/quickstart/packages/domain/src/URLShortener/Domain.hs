{-# LANGUAGE DeriveAnyClass #-}

module URLShortener.Domain (
    CreateURL (..),
    EditURL (..),
    ShortURL (..),
    ClickEvent (..),
    DateRange,
    mkDateRange,
    rangeStart,
    rangeEnd,
    validateDestination,
    validateCreateURL,
    validateEditURL,
    isRedirectable,
    eventWithinWindow,
    idempotencyExpiresAt,
    eventExpiresAt,
    exportExpiresAt,
) where

import Data.Aeson (FromJSON, ToJSON)
import Data.Bits (shiftR)
import Data.Char (isAsciiLower, isDigit, isHexDigit, isSpace)
import Data.Maybe (isNothing)
import Data.Text (Text)
import Data.Text qualified as T
import Data.Time (Day, UTCTime, addUTCTime, diffDays)
import GHC.Generics (Generic)
import Network.URI (URI (..), URIAuth (..), parseURI)
import Numeric (readHex)
import Text.Read (readMaybe)

-- Wire types remain untrusted until the corresponding validator succeeds.
data CreateURL = CreateURL {destination :: Text, expiresAt :: Maybe UTCTime}
    deriving (Eq, Show, Generic, FromJSON, ToJSON)
data EditURL = EditURL {destination :: Text, expiresAt :: Maybe UTCTime, version :: Int}
    deriving (Eq, Show, Generic, FromJSON, ToJSON)
data ShortURL = ShortURL
    { identifier :: Text
    , destination :: Text
    , createdAt :: UTCTime
    , expiresAt :: Maybe UTCTime
    , deletedAt :: Maybe UTCTime
    , version :: Int
    }
    deriving (Eq, Show, Generic, FromJSON, ToJSON)
data ClickEvent = ClickEvent {identifier :: Text, url :: Text, occurredAt :: UTCTime}
    deriving (Eq, Show, Generic, FromJSON, ToJSON)

data DateRange = DateRange {rangeStart :: Day, rangeEnd :: Day}
    deriving (Eq, Show)

-- Both endpoints are included: a leap year's 366 days are valid.
mkDateRange :: Day -> Day -> Either Text DateRange
mkDateRange start end
    | days < 0 = Left "end date precedes start date"
    | days >= 366 = Left "date range exceeds 366 days"
    | otherwise = Right (DateRange start end)
  where
    days = diffDays end start

-- Public DNS names and globally reachable IP literals are accepted. Private,
-- special-purpose addresses and noncanonical IPv4 numeric aliases are rejected.
-- DNS is never resolved and the destination is never fetched.
-- This does not promise that a DNS name will always resolve to a public address.
validateDestination :: Text -> Either Text Text
validateDestination value = case parseURI (T.unpack value) of
    Just parsed
        | uriScheme parsed `elem` ["http:", "https:"]
        , Just authority <- uriAuthority parsed
        , null (uriUserInfo authority)
        , validPort (uriPort authority)
        , allowedHost (T.toLower (T.pack (uriRegName authority)))
        , not (T.any (\c -> isSpace c || c < ' ' || c == '\\') value) ->
            Right value
    _ -> Left "destination must be an HTTP(S) URL with a public hostname or IP address and no credentials"
  where
    validPort "" = True
    validPort (':' : digits) =
        not (null digits)
            && all isDigit digits
            && length digits <= 5
            && (read digits :: Int) > 0
            && (read digits :: Int) <= 65535
    validPort _ = False
    allowedHost host
        | "[" `T.isPrefixOf` host && "]" `T.isSuffixOf` host =
            maybe False publicIPv6 (parseIPv6 (T.dropEnd 1 (T.drop 1 host)))
        | Just address <- parseIPv4 host =
            publicIPv4 address
        | otherwise = publicHost host
    publicHost host =
        T.length host <= 253
            && length labels >= 2
            && all validLabel labels
            && T.any isAsciiLower (last labels)
            && not ("0x" `T.isPrefixOf` last labels && T.all isHexDigit (T.drop 2 (last labels)))
            && not (any (\suffix -> host == suffix || ("." <> suffix) `T.isSuffixOf` host) reserved)
      where
        labels = T.splitOn "." host
    validLabel label =
        not (T.null label)
            && T.length label <= 63
            && T.head label /= '-'
            && T.last label /= '-'
            && T.all (\c -> isAsciiLower c || isDigit c || c == '-') label
    reserved = ["localhost", "local", "internal", "test", "invalid", "onion", "home.arpa"]

validateCreateURL :: UTCTime -> CreateURL -> Either Text CreateURL
validateCreateURL now value@(CreateURL target expiry) = do
    _ <- validateDestination target
    validateExpiry now expiry
    pure value

validateEditURL :: UTCTime -> EditURL -> Either Text EditURL
validateEditURL now value@(EditURL target expiry revision) = do
    _ <- validateDestination target
    validateExpiry now expiry
    if revision > 0 then Right value else Left "version must be positive"

validateExpiry :: UTCTime -> Maybe UTCTime -> Either Text ()
validateExpiry now expiry
    | maybe False (<= now) expiry = Left "expiry must be in the future"
    | otherwise = Right ()

isRedirectable :: UTCTime -> ShortURL -> Bool
isRedirectable now (ShortURL _ _ created expiry deleted _) =
    created <= now && isNothing deleted && maybe True (now <) expiry

-- Exact expiry is excluded, matching request-time expiration and cleanup.
eventWithinWindow :: UTCTime -> ClickEvent -> Bool
eventWithinWindow now (ClickEvent _ _ occurred) = occurred <= now && now < eventExpiresAt occurred

idempotencyExpiresAt, eventExpiresAt, exportExpiresAt :: UTCTime -> UTCTime
idempotencyExpiresAt = addUTCTime (7 * 86400)
eventExpiresAt = addUTCTime (30 * 86400)
exportExpiresAt = addUTCTime (7 * 86400)

-- IANA IPv4/IPv6 special-purpose registries, reviewed 2026-09-07:
-- https://www.iana.org/assignments/iana-ipv4-special-registry/
-- https://www.iana.org/assignments/iana-ipv6-special-registry/
-- More-specific globally reachable exceptions precede their parent blocks.
publicIPv4 :: Integer -> Bool
publicIPv4 address =
    any matches ["192.0.0.9/32", "192.0.0.10/32"]
        || not
            ( any
                matches
                [ "0.0.0.0/8"
                , "10.0.0.0/8"
                , "100.64.0.0/10"
                , "127.0.0.0/8"
                , "169.254.0.0/16"
                , "172.16.0.0/12"
                , "192.0.0.0/24"
                , "192.0.2.0/24"
                , "192.88.99.0/24"
                , "192.168.0.0/16"
                , "198.18.0.0/15"
                , "198.51.100.0/24"
                , "203.0.113.0/24"
                , "224.0.0.0/3"
                ]
            )
  where
    matches = inPrefix 32 parseIPv4 address

publicIPv6 :: Integer -> Bool
publicIPv6 address =
    any
        matches
        [ "64:ff9b::/96"
        , "2001:1::1/128"
        , "2001:1::2/128"
        , "2001:1::3/128"
        , "2001:3::/32"
        , "2001:4:112::/48"
        , "2001:20::/28"
        , "2001:30::/28"
        ]
        || ( matches "2000::/3"
                && not
                    ( any
                        matches
                        ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"]
                    )
           )
  where
    matches = inPrefix 128 parseIPv6 address

-- Strict decimal dotted quads exclude browser-supported octal/hex/short aliases.
parseIPv4 :: Text -> Maybe Integer
parseIPv4 raw = do
    let pieces = T.splitOn "." raw
    if length pieces /= 4
        then Nothing
        else do
            octets <- traverse octet pieces
            pure (foldl (\total part -> total * 256 + part) 0 octets)
  where
    octet value
        | T.null value || T.length value > 3 = Nothing
        | T.length value > 1 && T.head value == '0' = Nothing
        | not (T.all isDigit value) = Nothing
        | otherwise = do
            number <- readMaybe (T.unpack value)
            if number <= 255 then Just number else Nothing

-- RFC 4291 eight 16-bit groups, at most one ::, optional final IPv4 quad.
parseIPv6 :: Text -> Maybe Integer
parseIPv6 raw = do
    groups <- case T.splitOn "::" raw of
        [full] -> do
            values <- side full
            if length values == 8 then Just values else Nothing
        [left, right] -> do
            before <- side left
            after <- side right
            let missing = 8 - length before - length after
            if missing > 0 && not (T.any (== '.') left)
                then Just (before <> replicate missing 0 <> after)
                else Nothing
        _ -> Nothing
    pure (foldl (\total part -> total * 65536 + part) 0 groups)
  where
    side "" = Just []
    side value = walk (T.splitOn ":" value)
    walk [] = Just []
    walk [value] | T.any (== '.') value = do
        address <- parseIPv4 value
        pure [address `div` 65536, address `mod` 65536]
    walk (value : rest) = do
        part <- case readHex (T.unpack value) of
            [(number, "")] | not (T.null value) && T.length value <= 4 -> Just number
            _ -> Nothing
        remaining <- walk rest
        pure (part : remaining)

inPrefix :: Int -> (Text -> Maybe Integer) -> Integer -> Text -> Bool
inPrefix width parseAddress address prefix = case T.splitOn "/" prefix of
    [host, bits] -> case (parseAddress host, readMaybe (T.unpack bits)) of
        (Just network, Just size)
            | size >= 0 && size <= width ->
                shiftR address (width - size) == shiftR network (width - size)
        _ -> False
    _ -> False

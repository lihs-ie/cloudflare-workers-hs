module Cloudflare.Workers.URL (
    URL,
    parseURL,
    urlText,
    urlPath,
    urlPathRaw,
    urlQueryParam,
    urlQueryParams,
    urlQueryParamPresence,
    urlQueryParamOccurrences,
    urlQueryRaw,
    urlQueryStringVerbatim,
    percentDecode,
    percentEncodeQueryComponent,
) where

import Data.ByteString qualified as ByteString
import Data.Char (isDigit, ord)
import Data.Map.Strict (Map)
import Data.Map.Strict qualified as Map
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import Data.Text.Encoding.Error qualified as TextEncodingError
import Data.Word (Word8)

data URL = URL
    { urlTextField :: Text
    , urlPathField :: Text
    , urlPathRawField :: Text
    , urlQueryStringVerbatimField :: Text
    , urlQueryParametersField :: Map Text [Maybe Text]
    }
    deriving stock (Show, Eq)

parseURL :: Text -> Maybe URL
parseURL rawURL =
    if Text.null rawURL
        then Nothing
        else Just (URL withoutFragment decodedPath normalizedRawPath rawQuery queryParametersMap)
  where
    withoutFragment = Text.takeWhile (/= '#') rawURL
    pathAndQuery =
        if isAbsoluteURL
            then
                let afterScheme = Text.drop 3 (snd (Text.breakOn "://" withoutFragment))
                 in snd (Text.break (\authorityChar -> authorityChar == '/' || authorityChar == '?') afterScheme)
            else withoutFragment

    isAbsoluteURL = case Text.breakOn "://" withoutFragment of
        (beforeScheme, rest) ->
            not (Text.null rest) && not (Text.any (\schemeChar -> schemeChar == '/' || schemeChar == '?') beforeScheme)
    (rawPath, rawQueryWithLeadingMark) = Text.break (== '?') pathAndQuery
    rawQuery = Text.drop 1 rawQueryWithLeadingMark

    normalizedRawPath = case Text.null rawPath of
        True -> "/"
        False -> case Text.isPrefixOf "/" rawPath of
            True -> rawPath
            False -> Text.cons '/' rawPath

    decodedPath = percentDecode normalizedRawPath
    queryParametersMap = parseQueryString rawQuery

urlPath :: URL -> Text
urlPath = urlPathField

urlText :: URL -> Text
urlText = urlTextField

urlPathRaw :: URL -> Text
urlPathRaw = urlPathRawField

urlQueryParam :: Text -> URL -> Maybe Text
urlQueryParam name (URL _ _ _ _ queryParametersMap) =
    case Map.lookup name queryParametersMap of
        Just (value : _) -> Just (fromMaybe "" value)
        _ -> Nothing

urlQueryParams :: Text -> URL -> [Text]
urlQueryParams name (URL _ _ _ _ queryParametersMap) =
    map (fromMaybe "") (Map.findWithDefault [] name queryParametersMap)

urlQueryParamPresence :: Text -> URL -> Maybe (Maybe Text)
urlQueryParamPresence name (URL _ _ _ _ queryParametersMap) =
    case Map.lookup name queryParametersMap of
        Just (value : _) -> Just value
        _ -> Nothing

urlQueryParamOccurrences :: Text -> URL -> [Maybe Text]
urlQueryParamOccurrences name (URL _ _ _ _ queryParametersMap) =
    Map.findWithDefault [] name queryParametersMap

urlQueryRaw :: URL -> Text
urlQueryRaw (URL _ _ _ _ queryParametersMap) =
    if Map.null queryParametersMap
        then ""
        else Text.intercalate "&" (concatMap renderKeyOccurrences (Map.toAscList queryParametersMap))
  where
    renderKeyOccurrences :: (Text, [Maybe Text]) -> [Text]
    renderKeyOccurrences (key, occurrences) = map (renderOccurrence key) occurrences

    renderOccurrence :: Text -> Maybe Text -> Text
    renderOccurrence key Nothing = percentEncodeQueryComponent key
    renderOccurrence key (Just value) = percentEncodeQueryComponent key <> "=" <> percentEncodeQueryComponent value

urlQueryStringVerbatim :: URL -> Text
urlQueryStringVerbatim = urlQueryStringVerbatimField

percentEncodeQueryComponent :: Text -> Text
percentEncodeQueryComponent =
    Text.concat . map encodeByte . ByteString.unpack . TextEncoding.encodeUtf8
  where
    encodeByte :: Word8 -> Text
    encodeByte byte =
        if isUnreserved
            then Text.singleton (toEnum (fromIntegral byte))
            else Text.pack ['%', hexDigit (byte `div` 16), hexDigit (byte `mod` 16)]
      where
        isUnreserved =
            (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x61 && byte <= 0x7A)
                || (byte >= 0x30 && byte <= 0x39)
                || byte == 0x2D
                || byte == 0x2E
                || byte == 0x5F
                || byte == 0x7E
    hexDigit :: Word8 -> Char
    hexDigit nibble =
        if nibble < 10
            then toEnum (fromEnum '0' + fromIntegral nibble)
            else toEnum (fromEnum 'A' + fromIntegral nibble - 10)

parseQueryString :: Text -> Map Text [Maybe Text]
parseQueryString rawQuery =
    if Text.null rawQuery
        then Map.empty
        else foldl' addPair Map.empty (Text.splitOn "&" rawQuery)
  where
    addPair queryParametersMap rawPair =
        if Text.null rawPair
            then queryParametersMap
            else
                let (rawKey, rawValueWithLeadingMark) = Text.break (== '=') rawPair
                    decodedValue =
                        if Text.null rawValueWithLeadingMark
                            then Nothing
                            else Just (percentDecode (Text.drop 1 rawValueWithLeadingMark))
                 in Map.insertWith (flip (++)) (percentDecode rawKey) [decodedValue] queryParametersMap

percentDecode :: Text -> Text
percentDecode = TextEncoding.decodeUtf8With TextEncodingError.lenientDecode . ByteString.pack . collectBytes . Text.unpack
  where
    collectBytes :: String -> [Word8]
    collectBytes ('%' : highNibbleChar : lowNibbleChar : rest)
        | Just decodedByte <- decodeHexPair highNibbleChar lowNibbleChar = decodedByte : collectBytes rest
    collectBytes (character : rest) =
        ByteString.unpack (TextEncoding.encodeUtf8 (Text.singleton character)) ++ collectBytes rest
    collectBytes [] = []

decodeHexPair :: Char -> Char -> Maybe Word8
decodeHexPair highNibbleChar lowNibbleChar = do
    highNibble <- hexDigitToInt highNibbleChar
    lowNibble <- hexDigitToInt lowNibbleChar
    pure (fromIntegral (highNibble * 16 + lowNibble))

hexDigitToInt :: Char -> Maybe Int
hexDigitToInt character = case isDigit character of
    True -> Just (ord character - ord '0')
    False -> case character >= 'a' && character <= 'f' of
        True -> Just (ord character - ord 'a' + 10)
        False -> case character >= 'A' && character <= 'F' of
            True -> Just (ord character - ord 'A' + 10)
            False -> Nothing

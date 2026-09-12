module Cloudflare.Workers.Headers (
    Headers,
    headersFromList,
    headersToList,
    headerLookup,
    headerLookupAll,
    headerInsert,
    headerAppend,
) where

import Data.Map.Strict (Map)
import Data.Map.Strict qualified as Map
import Data.Text (Text)
import Data.Text qualified as Text

newtype Headers = Headers (Map Text [Text])
    deriving stock (Show, Eq)

normalizeHeaderName :: Text -> Text
normalizeHeaderName = Text.toLower

headersFromList :: [(Text, Text)] -> Headers
headersFromList = foldl' (\headers (name, value) -> headerAppend name value headers) (Headers Map.empty)

headersToList :: Headers -> [(Text, Text)]
headersToList (Headers headerMap) =
    [(name, value) | (name, values) <- Map.toList headerMap, value <- values]

headerLookup :: Text -> Headers -> Maybe Text
headerLookup name (Headers headerMap) =
    case Map.lookup (normalizeHeaderName name) headerMap of
        Just (value : _) -> Just value
        _ -> Nothing

headerLookupAll :: Text -> Headers -> [Text]
headerLookupAll name (Headers headerMap) =
    Map.findWithDefault [] (normalizeHeaderName name) headerMap

headerInsert :: Text -> Text -> Headers -> Headers
headerInsert name value (Headers headerMap) =
    Headers (Map.insert (normalizeHeaderName name) [value] headerMap)

headerAppend :: Text -> Text -> Headers -> Headers
headerAppend name value (Headers headerMap) =
    Headers
        ( Map.insertWith
            (flip (++))
            (normalizeHeaderName name)
            [value]
            headerMap
        )

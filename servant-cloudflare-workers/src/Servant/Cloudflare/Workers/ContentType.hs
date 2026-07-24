module Servant.Cloudflare.Workers.ContentType (handleContentNegotiation) where

import Cloudflare.Workers.HTTP (Request (requestHeaders))
import Data.Text (Text)
import Data.Text qualified as Text
import Servant.Cloudflare.Workers.Error (ServerError, err406, err415)

handleContentNegotiation :: Request -> [Text] -> Either ServerError Text
handleContentNegotiation request contentTypes =
    case lookup "Content-Type" (requestHeaders request) of
        Just requestContentType
            | requestContentType `notElem` contentTypes ->
                Left err415
        _ -> negotiateAccept
  where
    acceptRanges = map Text.strip . Text.splitOn ","

    pickFirstSupported :: Either ServerError Text
    pickFirstSupported =
        case contentTypes of
            (contentType : _) -> Right contentType
            [] -> Left err406

    negotiateAccept :: Either ServerError Text
    negotiateAccept =
        case lookup "Accept" (requestHeaders request) of
            Nothing -> pickFirstSupported
            Just acceptHeader
                | "*/*" `elem` acceptRanges acceptHeader -> pickFirstSupported
                | otherwise ->
                    case filter (`elem` acceptRanges acceptHeader) contentTypes of
                        (matched : _) -> Right matched
                        [] -> Left err406

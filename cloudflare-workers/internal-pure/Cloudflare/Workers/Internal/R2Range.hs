module Cloudflare.Workers.Internal.R2Range (
    r2RangeComponentToJSNumber,
) where

import Data.Text (Text)
import Data.Text qualified as Text

maximumExactJSInteger :: Integer
maximumExactJSInteger = 9007199254740991

r2RangeComponentToJSNumber :: Text -> Integer -> Either Text Double
r2RangeComponentToJSNumber componentName componentValue
    | componentValue < 0 =
        Left
            ( componentName
                <> ": "
                <> Text.pack (show componentValue)
                <> " is negative; an R2 range component must be a non-negative byte count"
            )
    | componentValue > maximumExactJSInteger =
        Left
            ( componentName
                <> ": "
                <> Text.pack (show componentValue)
                <> " exceeds the largest integer a JS number represents exactly ("
                <> Text.pack (show maximumExactJSInteger)
                <> "), so it cannot cross this boundary without being rounded"
            )
    | otherwise = Right (fromInteger componentValue)

module Cloudflare.Workers.Internal.Images.FFITypes (
    ImageInfoViaFFI (..),
    ImageTransformationViaFFI (..),
    ImagesErrorViaFFI (..),
) where

import Data.Text (Text)

data ImageInfoViaFFI
    = SVGImageInfoViaFFI
    | RasterImageInfoViaFFI Text Integer Int Int

data ImageTransformationViaFFI
    = ResizeToWidthViaFFI Int
    | ResizeToHeightViaFFI Int
    | ResizeToDimensionsViaFFI Int Int
    | RotateViaFFI Int

data ImagesErrorViaFFI = ImagesErrorViaFFI
    { imagesErrorCodeViaFFI :: Maybe Int
    , imagesErrorNameViaFFI :: Maybe Text
    , imagesErrorMessageViaFFI :: Text
    }

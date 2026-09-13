module Cloudflare.Workers.Internal.Images (
    ImageDimension,
    ImageDimensionError (..),
    createImageDimension,
    imageDimensionPixels,
    ImageFormat (..),
    ImageInfo (..),
    ImageResize (..),
    ImageRotation (..),
    ImageTransformation (..),
    ImageOutputFormat (..),
    ImageAnimation (..),
    ImageOutputOptions (..),
    ImagesError (..),
    fromImageInfoViaFFI,
    toTransformationViaFFI,
    toOutputOptionsViaFFI,
    fromErrorViaFFI,
) where

import Cloudflare.Workers.Internal.Images.FFITypes (
    ImageInfoViaFFI (..),
    ImageTransformationViaFFI (..),
    ImagesErrorViaFFI (..),
 )
import Data.Text (Text)

newtype ImageDimension = ImageDimension
    { imageDimensionPixels :: Int
    }
    deriving stock (Show, Eq, Ord)

data ImageDimensionError = ImageDimensionMustBePositive
    deriving stock (Show, Eq)

createImageDimension :: Int -> Either ImageDimensionError ImageDimension
createImageDimension pixels
    | pixels > 0 = Right (ImageDimension pixels)
    | otherwise = Left ImageDimensionMustBePositive

data ImageFormat
    = ImagePNG
    | ImageJPEG
    | ImageGIF
    | ImageWebP
    | ImageAVIF
    | ImageHEIC
    | ImageOther Text
    deriving stock (Show, Eq)

data ImageInfo
    = RasterImageInfo ImageFormat Integer ImageDimension ImageDimension
    | SVGImageInfo
    deriving stock (Show, Eq)

data ImageResize
    = ResizeToWidth ImageDimension
    | ResizeToHeight ImageDimension
    | ResizeToDimensions ImageDimension ImageDimension
    deriving stock (Show, Eq)

data ImageRotation
    = Rotate0
    | Rotate90
    | Rotate180
    | Rotate270
    deriving stock (Show, Eq)

data ImageTransformation
    = ImageResize ImageResize
    | ImageRotate ImageRotation
    deriving stock (Show, Eq)

data ImageOutputFormat
    = OutputPNG
    | OutputJPEG
    | OutputGIF
    | OutputWebP
    | OutputAVIF
    deriving stock (Show, Eq)

data ImageAnimation
    = PreserveAnimation
    | FirstFrameOnly
    deriving stock (Show, Eq)

data ImageOutputOptions = ImageOutputOptions
    { imageOutputFormat :: ImageOutputFormat
    , imageOutputAnimation :: ImageAnimation
    }
    deriving stock (Show, Eq)

data ImagesError = ImagesError
    { imagesErrorCode :: Maybe Int
    , imagesErrorName :: Maybe Text
    , imageErrorMessage :: Text
    }
    deriving stock (Show, Eq)

fromImageInfoViaFFI :: ImageInfoViaFFI -> Either ImagesError ImageInfo
fromImageInfoViaFFI SVGImageInfoViaFFI = Right SVGImageInfo
fromImageInfoViaFFI (RasterImageInfoViaFFI rawFormat fileSize widthPixels heightPixels) = do
    width <- dimensionFromCloudflare "width" widthPixels
    height <- dimensionFromCloudflare "height" heightPixels
    pure (RasterImageInfo (imageFormatFromContentType rawFormat) fileSize width height)
  where
    dimensionFromCloudflare :: Text -> Int -> Either ImagesError ImageDimension
    dimensionFromCloudflare fieldName pixels =
        case createImageDimension pixels of
            Right dimension -> Right dimension
            Left ImageDimensionMustBePositive ->
                Left
                    ( ImagesError
                        Nothing
                        Nothing
                        ("Cloudflare Images returned a non-positive " <> fieldName)
                    )

imageFormatFromContentType :: Text -> ImageFormat
imageFormatFromContentType "image/png" = ImagePNG
imageFormatFromContentType "image/jpeg" = ImageJPEG
imageFormatFromContentType "image/gif" = ImageGIF
imageFormatFromContentType "image/webp" = ImageWebP
imageFormatFromContentType "image/avif" = ImageAVIF
imageFormatFromContentType "image/heic" = ImageHEIC
imageFormatFromContentType contentType = ImageOther contentType

rotationDegrees :: ImageRotation -> Int
rotationDegrees Rotate0 = 0
rotationDegrees Rotate90 = 90
rotationDegrees Rotate180 = 180
rotationDegrees Rotate270 = 270

toTransformationViaFFI :: ImageTransformation -> ImageTransformationViaFFI
toTransformationViaFFI (ImageResize resize) =
    case resize of
        ResizeToWidth width -> ResizeToWidthViaFFI (imageDimensionPixels width)
        ResizeToHeight height -> ResizeToHeightViaFFI (imageDimensionPixels height)
        ResizeToDimensions width height ->
            ResizeToDimensionsViaFFI (imageDimensionPixels width) (imageDimensionPixels height)
toTransformationViaFFI (ImageRotate rotation) = RotateViaFFI (rotationDegrees rotation)

toOutputOptionsViaFFI :: ImageOutputOptions -> (Text, Bool)
toOutputOptionsViaFFI options =
    ( outputFormatContentType (imageOutputFormat options)
    , imageOutputAnimation options == PreserveAnimation
    )

outputFormatContentType :: ImageOutputFormat -> Text
outputFormatContentType OutputPNG = "image/png"
outputFormatContentType OutputJPEG = "image/jpeg"
outputFormatContentType OutputGIF = "image/gif"
outputFormatContentType OutputWebP = "image/webp"
outputFormatContentType OutputAVIF = "image/avif"

fromErrorViaFFI :: ImagesErrorViaFFI -> ImagesError
fromErrorViaFFI (ImagesErrorViaFFI code name message) = ImagesError code name message

module Cloudflare.Workers.Binding.Images (
    Images (Images),
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
    ImageOutput (..),
    imagesInfo,
    imagesTransform,
    imageOutputToResponse,
) where

import Cloudflare.Workers.HTTP (
    Response,
    ResponseBody (ResponseBodyStream),
    Status (Status),
    createResponse,
 )
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Internal.Images
import Cloudflare.Workers.Internal.FFI.Images (
    ImagesOutputViaFFI (..),
    imagesInfoViaFFI,
    imagesTransformViaFFI,
 )
import Cloudflare.Workers.Streaming (ReadableStream, readableStreamFromJSVal, readableStreamToJSVal)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

newtype Images = Images JSVal

data ImageOutput = ImageOutput
    { imageOutputContentType :: Text
    , imageOutputBody :: ReadableStream
    }

imagesInfo :: Images -> ReadableStream -> IO (Either ImagesError ImageInfo)
imagesInfo (Images bindingJSVal) inputStream = do
    outcome <- imagesInfoViaFFI bindingJSVal (readableStreamToJSVal inputStream)
    pure (either (Left . fromErrorViaFFI) fromImageInfoViaFFI outcome)

imagesTransform ::
    Images ->
    ReadableStream ->
    [ImageTransformation] ->
    ImageOutputOptions ->
    IO (Either ImagesError ImageOutput)
imagesTransform (Images bindingJSVal) inputStream transformations outputOptions = do
    let (outputFormat, preserveAnimation) = toOutputOptionsViaFFI outputOptions
    outcome <-
        imagesTransformViaFFI
            bindingJSVal
            (readableStreamToJSVal inputStream)
            (fmap toTransformationViaFFI transformations)
            outputFormat
            preserveAnimation
    pure (either (Left . fromErrorViaFFI) (Right . fromOutputViaFFI) outcome)

imageOutputToResponse :: ImageOutput -> Response
imageOutputToResponse output =
    createResponse
        (Status 200)
        (headersFromList [("content-type", imageOutputContentType output)])
        (ResponseBodyStream (imageOutputBody output))

fromOutputViaFFI :: ImagesOutputViaFFI -> ImageOutput
fromOutputViaFFI (ImagesOutputViaFFI contentType imageJSVal) =
    ImageOutput contentType (readableStreamFromJSVal imageJSVal)

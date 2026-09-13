module Cloudflare.Workers.Binding.ImagesSpec (spec) where

import Cloudflare.Workers.Binding.Images
import Cloudflare.Workers.HTTP (Response (..), ResponseBody (..), Status (..))
import Cloudflare.Workers.Headers (headersToList)
import Cloudflare.Workers.Internal.Images qualified as Internal
import Cloudflare.Workers.Internal.Images.FFITypes qualified as FFI
import Cloudflare.Workers.Streaming (ReadableStream)
import Control.Monad (forM_)
import Data.Text (Text)
import Test.Syd

spec :: Spec
spec = do
    it "rejects zero and negative dimensions" $
        map createImageDimension [minBound, -1, 0]
            `shouldBe` replicate 3 (Left ImageDimensionMustBePositive)
    it "preserves accepted pixel counts exactly" $
        map (fmap imageDimensionPixels . createImageDimension) [1, 2, maxBound]
            `shouldBe` map Right [1, 2, maxBound]

    describe "image information" $ do
        it "recognizes SVG without raster metadata" $
            Internal.fromImageInfoViaFFI FFI.SVGImageInfoViaFFI
                `shouldBe` Right Internal.SVGImageInfo

        forM_ inputFormats $ \(mime, format) ->
            it ("decodes " <> show mime <> " and preserves size and dimensions") $ do
                width <- internalDimension 13
                height <- internalDimension 7
                Internal.fromImageInfoViaFFI (FFI.RasterImageInfoViaFFI mime 9007199254740991 13 7)
                    `shouldBe` Right (Internal.RasterImageInfo format 9007199254740991 width height)

        forM_ [0, -1, minBound] $ \pixels -> do
            it ("rejects invalid width " <> show pixels) $
                Internal.fromImageInfoViaFFI (FFI.RasterImageInfoViaFFI "image/png" 42 pixels 7)
                    `shouldBe` Left (Internal.ImagesError Nothing Nothing "Cloudflare Images returned a non-positive width")
            it ("rejects invalid height " <> show pixels) $
                Internal.fromImageInfoViaFFI (FFI.RasterImageInfoViaFFI "image/png" 42 13 pixels)
                    `shouldBe` Left (Internal.ImagesError Nothing Nothing "Cloudflare Images returned a non-positive height")

        it "accepts zero file size and maximum Int dimensions without narrowing" $ do
            largest <- internalDimension maxBound
            Internal.fromImageInfoViaFFI (FFI.RasterImageInfoViaFFI "image/png" 0 maxBound maxBound)
                `shouldBe` Right (Internal.RasterImageInfo Internal.ImagePNG 0 largest largest)

    describe "transformation arguments" $ do
        it "sets width only for ResizeToWidth" $ do
            width <- internalDimension 13
            case Internal.toTransformationViaFFI (Internal.ImageResize (Internal.ResizeToWidth width)) of
                FFI.ResizeToWidthViaFFI pixels -> pixels `shouldBe` 13
                _ -> expectationFailure "Expected a width-only resize"

        it "sets height only for ResizeToHeight" $ do
            height <- internalDimension 7
            case Internal.toTransformationViaFFI (Internal.ImageResize (Internal.ResizeToHeight height)) of
                FFI.ResizeToHeightViaFFI pixels -> pixels `shouldBe` 7
                _ -> expectationFailure "Expected a height-only resize"

        it "does not swap width and height for ResizeToDimensions" $ do
            width <- internalDimension 13
            height <- internalDimension 7
            case Internal.toTransformationViaFFI (Internal.ImageResize (Internal.ResizeToDimensions width height)) of
                FFI.ResizeToDimensionsViaFFI w h -> (w, h) `shouldBe` (13, 7)
                _ -> expectationFailure "Expected a two-dimensional resize"

        forM_ [(Internal.Rotate0, 0), (Internal.Rotate90, 90), (Internal.Rotate180, 180), (Internal.Rotate270, 270)] $ \(rotation, degrees) ->
            it ("encodes " <> show rotation <> " in degrees") $
                case Internal.toTransformationViaFFI (Internal.ImageRotate rotation) of
                    FFI.RotateViaFFI value -> value `shouldBe` degrees
                    _ -> expectationFailure "Expected rotation"

    describe "output options" $
        forM_ [(Internal.OutputPNG, "image/png"), (Internal.OutputJPEG, "image/jpeg"), (Internal.OutputGIF, "image/gif"), (Internal.OutputWebP, "image/webp"), (Internal.OutputAVIF, "image/avif")] $ \(format, mime) ->
            forM_ [(Internal.PreserveAnimation, True), (Internal.FirstFrameOnly, False)] $ \(animation, preserve) ->
                it ("encodes " <> show format <> " with " <> show animation) $
                    Internal.toOutputOptionsViaFFI (Internal.ImageOutputOptions format animation)
                        `shouldBe` (mime, preserve)

    describe "error conversion" $ do
        it "preserves the service code, name and message" $
            Internal.fromErrorViaFFI (FFI.ImagesErrorViaFFI (Just 9412) (Just "Error") "画像を読み取れません")
                `shouldBe` Internal.ImagesError (Just 9412) (Just "Error") "画像を読み取れません"
        it "does not invent missing error fields" $
            Internal.fromErrorViaFFI (FFI.ImagesErrorViaFFI Nothing Nothing "rejected")
                `shouldBe` Internal.ImagesError Nothing Nothing "rejected"
        it "preserves decode-error classification" $
            Internal.fromErrorViaFFI (FFI.ImagesErrorViaFFI Nothing (Just "ImagesBindingDecodeError") "info.width: invalid")
                `shouldBe` Internal.ImagesError Nothing (Just "ImagesBindingDecodeError") "info.width: invalid"

    describe "response construction" $ do
        let body = error "Response construction evaluated the stream" :: ReadableStream
            response = imageOutputToResponse (ImageOutput "image/future" body)
        it "returns status 200" $
            responseStatus response `shouldBe` Status 200
        it "uses the output content type without replacing unknown formats" $
            headersToList (responseHeaders response) `shouldBe` [("content-type", "image/future")]
        it "keeps the body streaming without evaluating it" $
            case responseBody response of
                ResponseBodyStream _ -> pure ()
                _ -> expectationFailure "Expected a streaming response body"

internalDimension :: Int -> IO Internal.ImageDimension
internalDimension = either (fail . show) pure . Internal.createImageDimension

inputFormats :: [(Text, Internal.ImageFormat)]
inputFormats =
    [ ("image/png", Internal.ImagePNG)
    , ("image/jpeg", Internal.ImageJPEG)
    , ("image/gif", Internal.ImageGIF)
    , ("image/webp", Internal.ImageWebP)
    , ("image/avif", Internal.ImageAVIF)
    , ("image/heic", Internal.ImageHEIC)
    , ("image/future", Internal.ImageOther "image/future")
    ]

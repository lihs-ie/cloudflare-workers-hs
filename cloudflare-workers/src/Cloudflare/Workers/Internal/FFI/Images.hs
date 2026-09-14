module Cloudflare.Workers.Internal.FFI.Images (
    ImageInfoViaFFI (..),
    ImageTransformationViaFFI (..),
    ImagesErrorViaFFI (..),
    ImagesOutputViaFFI (..),
    imagesInfoViaFFI,
    imagesTransformViaFFI,
) where

import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnvelopedWithError)
import Cloudflare.Workers.Internal.FFI.Text (jsValToText, textToJSVal)
import Cloudflare.Workers.Internal.Images.FFITypes
import Control.Monad (forM_)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

data ImagesOutputViaFFI = ImagesOutputViaFFI Text JSVal

imagesInfoViaFFI :: JSVal -> JSVal -> IO (Either ImagesErrorViaFFI ImageInfoViaFFI)
imagesInfoViaFFI bindingJSVal streamJSVal = do
    operations <- jsImagesOperations minBound maxBound
    decodeEnvelopedWithError decodeInfoValue decodeError malformedEnvelopeError
        =<< jsImagesInfoEnveloped operations bindingJSVal streamJSVal

imagesTransformViaFFI ::
    JSVal ->
    JSVal ->
    [ImageTransformationViaFFI] ->
    Text ->
    Bool ->
    IO (Either ImagesErrorViaFFI ImagesOutputViaFFI)
imagesTransformViaFFI bindingJSVal streamJSVal transformations outputFormat preserveAnimation = do
    operations <- jsImagesOperations minBound maxBound
    transformationsJSVal <- jsEmptyArray
    forM_ transformations (appendTransformation transformationsJSVal)
    outputFormatJSVal <- textToJSVal outputFormat
    decodeEnvelopedWithError decodeOutputValue decodeError malformedEnvelopeError
        =<< jsImagesTransformEnveloped
            operations
            bindingJSVal
            streamJSVal
            transformationsJSVal
            outputFormatJSVal
            preserveAnimation

appendTransformation :: JSVal -> ImageTransformationViaFFI -> IO ()
appendTransformation transformationsJSVal transformation =
    case transformation of
        ResizeToWidthViaFFI width -> jsPushResizeWidth transformationsJSVal width
        ResizeToHeightViaFFI height -> jsPushResizeHeight transformationsJSVal height
        ResizeToDimensionsViaFFI width height -> jsPushResizeDimensions transformationsJSVal width height
        RotateViaFFI rotation -> jsPushRotation transformationsJSVal rotation

decodeInfoValue :: JSVal -> IO ImageInfoViaFFI
decodeInfoValue valueJSVal = do
    format <- jsValToText =<< jsInfoFormat valueJSVal
    if format == "image/svg+xml"
        then pure SVGImageInfoViaFFI
        else do
            fileSize <- round <$> jsInfoFileSize valueJSVal
            width <- round <$> jsInfoWidth valueJSVal
            height <- round <$> jsInfoHeight valueJSVal
            pure (RasterImageInfoViaFFI format fileSize width height)

decodeOutputValue :: JSVal -> IO ImagesOutputViaFFI
decodeOutputValue valueJSVal = do
    contentType <- jsValToText =<< jsOutputContentType valueJSVal
    imageJSVal <- jsOutputImage valueJSVal
    pure (ImagesOutputViaFFI contentType imageJSVal)

decodeError :: JSVal -> IO ImagesErrorViaFFI
decodeError errorJSVal = do
    hasCode <- jsErrorHasCode errorJSVal
    code <- if hasCode then Just . round <$> jsErrorCode errorJSVal else pure Nothing
    hasName <- jsErrorHasName errorJSVal
    name <- if hasName then Just <$> (jsValToText =<< jsErrorName errorJSVal) else pure Nothing
    message <- jsValToText =<< jsErrorMessage errorJSVal
    pure (ImagesErrorViaFFI code name message)

malformedEnvelopeError :: Text -> ImagesErrorViaFFI
malformedEnvelopeError = ImagesErrorViaFFI Nothing (Just "ImagesBindingDecodeError")

foreign import javascript unsafe "[]"
    jsEmptyArray :: IO JSVal

foreign import javascript unsafe "$1.push({ width: $2 })"
    jsPushResizeWidth :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.push({ height: $2 })"
    jsPushResizeHeight :: JSVal -> Int -> IO ()

foreign import javascript unsafe "$1.push({ width: $2, height: $3 })"
    jsPushResizeDimensions :: JSVal -> Int -> Int -> IO ()

foreign import javascript unsafe "$1.push({ rotate: $2 })"
    jsPushRotation :: JSVal -> Int -> IO ()

foreign import javascript unsafe
    """
    (() => {
      const minimumInt = $1;
      const maximumInt = $2;

      const failure = message => ({
        ok: false,
        error: {
          code: null,
          name: 'ImagesBindingDecodeError',
          message
        }
      });

      const integer = value =>
        Number.isInteger(value) &&
        value >= minimumInt &&
        value <= maximumInt;

      const nonEmptyString = value =>
        typeof value === 'string' && value.length > 0;

      const caught = error => {
        try {
          const code = error?.code;

          if (code != null && !integer(code)) {
            return failure('error.code: expected an integer representable by Int');
          }

          const name = error?.name;
          const message = error?.message;

          return {
            ok: false,
            error: {
              code: code ?? null,
              name: typeof name === 'string' ? name : null,
              message: typeof message === 'string' ? message : String(error)
            }
          };
        } catch {
          return failure('error: could not read the thrown value');
        }
      };

      return {
        async info(binding, stream) {
          let result;

          try {
            result = await binding.info(stream);
          } catch (error) {
            return caught(error);
          }

          try {
            const format = result?.format;

            if (!nonEmptyString(format)) {
              return failure('info.format: expected a non-empty string');
            }

            if (format === 'image/svg+xml') {
              return {
                ok: true,
                value: { format }
              };
            }

            const fileSize = result.fileSize;

            if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
              return failure('info.fileSize: expected a non-negative safe integer');
            }

            const width = result.width;

            if (!integer(width) || width <= 0) {
              return failure('info.width: expected a positive integer representable by Int');
            }

            const height = result.height;

            if (!integer(height) || height <= 0) {
              return failure('info.height: expected a positive integer representable by Int');
            }

            return {
              ok: true,
              value: {
                format,
                fileSize,
                width,
                height
              }
            };
          } catch {
            return failure('info: could not read image information');
          }
        },

        async transform(binding, stream, transformations, format, anim) {
          let result;

          try {
            let transformer = binding.input(stream);

            for (const transformation of transformations) {
              transformer = transformer.transform(transformation);
            }

            result = await transformer.output({
              format,
              anim: !!anim
            });
          } catch (error) {
            return caught(error);
          }

          let contentTypeMethod;
          let imageMethod;

          try {
            contentTypeMethod = result?.contentType;
            imageMethod = result?.image;
          } catch {
            return failure('output: could not read result methods');
          }

          if (typeof contentTypeMethod !== 'function') {
            return failure('output.contentType: expected a method');
          }

          if (typeof imageMethod !== 'function') {
            return failure('output.image: expected a method');
          }

          let contentType;
          let image;

          try {
            contentType = contentTypeMethod.call(result);
            image = imageMethod.call(result);
          } catch (error) {
            return caught(error);
          }

          if (!nonEmptyString(contentType)) {
            return failure('output.contentType: expected a non-empty string');
          }

          try {
            const locked = Object.getOwnPropertyDescriptor(
              ReadableStream.prototype,
              'locked'
            ).get.call(image);

            if (locked) {
              return failure('output.image: expected an unlocked ReadableStream');
            }

            new Response(image);
          } catch {
            return failure('output.image: expected an unconsumed ReadableStream');
          }

          return {
            ok: true,
            value: {
              contentType,
              image
            }
          };
        }
      };
    })()
    """
    jsImagesOperations :: Int -> Int -> IO JSVal

foreign import javascript safe "$1.info($2, $3)"
    jsImagesInfoEnveloped :: JSVal -> JSVal -> JSVal -> IO JSVal

foreign import javascript safe "$1.transform($2, $3, $4, $5, $6)"
    jsImagesTransformEnveloped :: JSVal -> JSVal -> JSVal -> JSVal -> JSVal -> Bool -> IO JSVal

foreign import javascript unsafe "$1.format"
    jsInfoFormat :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.fileSize"
    jsInfoFileSize :: JSVal -> IO Double

foreign import javascript unsafe "$1.width"
    jsInfoWidth :: JSVal -> IO Double

foreign import javascript unsafe "$1.height"
    jsInfoHeight :: JSVal -> IO Double

foreign import javascript unsafe "$1.contentType"
    jsOutputContentType :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.image"
    jsOutputImage :: JSVal -> IO JSVal

foreign import javascript unsafe "Number.isFinite($1.code)"
    jsErrorHasCode :: JSVal -> IO Bool

foreign import javascript unsafe "$1.code"
    jsErrorCode :: JSVal -> IO Double

foreign import javascript unsafe "typeof $1.name === 'string'"
    jsErrorHasName :: JSVal -> IO Bool

foreign import javascript unsafe "$1.name"
    jsErrorName :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.message"
    jsErrorMessage :: JSVal -> IO JSVal

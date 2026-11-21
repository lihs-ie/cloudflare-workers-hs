module Support.Runtime.Images (probeImages) where

import Cloudflare.Workers.Binding.Images
import Cloudflare.Workers.Entrypoint.Fetch (FetchHandler, createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv, getBinding)
import Cloudflare.Workers.HTTP (Response, ResponseBody (ResponseBodyLazyBytes), Status (Status), createResponse, requestBody, requestPath)
import Cloudflare.Workers.Headers (headersFromList)
import Data.Aeson (Value, encode, object, (.=))
import Data.Proxy (Proxy (Proxy))
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

type ProbeBindings = '[ '("IMAGES", Images)]

probeImages :: JSVal -> JSVal -> JSVal -> IO JSVal
probeImages = createFetchHandler handleProbe

handleProbe :: FetchHandler (BindingEnv '[] '[] ProbeBindings)
handleProbe request env _context = do
    stream <- maybe (fail "Images probe requires an input body") pure (requestBody request)
    let binding = getBinding (Proxy @"IMAGES") env
        command = Text.drop (Text.length "/__fixture/images/") (requestPath request)
    if command == "info"
        then json . either errorValue infoValue <$> imagesInfo binding stream
        else do
            width <- either (fail . show) pure (createImageDimension 13)
            height <- either (fail . show) pure (createImageDimension 7)
            let transformations =
                    [ ImageResize (ResizeToWidth width)
                    , ImageResize (ResizeToHeight height)
                    , ImageResize (ResizeToDimensions width height)
                    , ImageRotate Rotate0
                    , ImageRotate Rotate90
                    , ImageRotate Rotate180
                    , ImageRotate Rotate270
                    ]
                format = case Text.takeWhile (/= '-') command of
                    "jpeg" -> OutputJPEG
                    "gif" -> OutputGIF
                    "webp" -> OutputWebP
                    "avif" -> OutputAVIF
                    _ -> OutputPNG
                animation = if "-first" `Text.isSuffixOf` command then FirstFrameOnly else PreserveAnimation
            either (pure . json . errorValue) (pure . imageOutputToResponse)
                =<< imagesTransform binding stream transformations (ImageOutputOptions format animation)

infoValue :: ImageInfo -> Value
infoValue SVGImageInfo = object ["kind" .= ("svg" :: Text.Text)]
infoValue (RasterImageInfo format fileSize width height) =
    object
        [ "kind" .= ("raster" :: Text.Text)
        , "format" .= show format
        , "fileSize" .= fileSize
        , "width" .= imageDimensionPixels width
        , "height" .= imageDimensionPixels height
        ]

errorValue :: ImagesError -> Value
errorValue failure = object
    [ "code" .= imagesErrorCode failure
    , "name" .= imagesErrorName failure
    , "message" .= imageErrorMessage failure
    ]

json :: Value -> Response
json = createResponse (Status 200) (headersFromList [("content-type", "application/json")]) . ResponseBodyLazyBytes . encode

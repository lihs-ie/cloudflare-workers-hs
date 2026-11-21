module Main (main) where

import Support.Runtime.ExportRequestCodec qualified as ExportRequestCodec
import Support.Runtime.ExportProducer qualified as ExportProducer
import Support.Runtime.UrlShortenerDatabase qualified as UrlShortenerDatabase
import Support.Runtime.GenerationAsync qualified as GenerationAsync
import Support.Runtime.UrlShortenerBoundaries qualified as UrlShortenerBoundaries

import GHC.Wasm.Prim (JSVal)
import Trace.Hpc.Reflect (examineTix)
import WorkersSupport.Interop (textToJSVal)
import Data.Text qualified as Text

main :: IO ()
main = pure ()

coverage :: IO JSVal
coverage = examineTix >>= textToJSVal . Text.pack . show
foreign export javascript "coverage" coverage :: IO JSVal

urlShortenerManagementProbe :: JSVal -> Int -> JSVal -> JSVal -> IO JSVal
urlShortenerManagementProbe = UrlShortenerBoundaries.managementFetch
foreign export javascript "urlShortenerManagementProbe" urlShortenerManagementProbe :: JSVal -> Int -> JSVal -> JSVal -> IO JSVal

urlShortenerLeaseProbe :: JSVal -> Int -> IO JSVal
urlShortenerLeaseProbe = UrlShortenerBoundaries.leaseProbe
foreign export javascript "urlShortenerLeaseProbe" urlShortenerLeaseProbe :: JSVal -> Int -> IO JSVal

urlShortenerDatabasePreparedProbe :: JSVal -> IO JSVal
urlShortenerDatabasePreparedProbe = UrlShortenerDatabase.preparedQueryProbe
foreign export javascript "urlShortenerDatabasePreparedProbe" urlShortenerDatabasePreparedProbe :: JSVal -> IO JSVal

generationAsyncProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
generationAsyncProbe = GenerationAsync.generationAsyncProbe
foreign export javascript "generationAsyncProbe" generationAsyncProbe :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

exportRequestCodecProbe :: JSVal -> IO JSVal
exportRequestCodecProbe = ExportRequestCodec.exportRequestCodecProbe
foreign export javascript "exportRequestCodecProbe" exportRequestCodecProbe :: JSVal -> IO JSVal

exportProducerProbe :: JSVal -> IO JSVal
exportProducerProbe = ExportProducer.exportProducerProbe
foreign export javascript "exportProducerProbe" exportProducerProbe :: JSVal -> IO JSVal

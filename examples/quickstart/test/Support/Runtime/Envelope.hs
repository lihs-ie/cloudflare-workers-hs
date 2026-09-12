module Envelope (envelopeProbe) where

import Cloudflare.Workers.Internal.FFI.Envelope (decodeEnveloped)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Data.Aeson qualified as Aeson
import Data.ByteString.Lazy qualified as LazyBytes
import Data.IORef (newIORef, modifyIORef', readIORef)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as TextEncoding
import GHC.Wasm.Prim (JSVal)

-- The decoder counter distinguishes rejected envelopes from failed value decoding.
envelopeProbe :: JSVal -> IO JSVal
envelopeProbe input = do
    calls <- newIORef (0 :: Int)
    outcome <- decodeEnveloped (\_ -> modifyIORef' calls (+ 1) >> pure ("decoded" :: Text.Text)) input
    count <- readIORef calls
    let value = Aeson.object
            [ "succeeded" Aeson..= either (const False) (const True) outcome
            , "message" Aeson..= either id id outcome
            , "decoderCalls" Aeson..= count
            ]
    textToJSVal (TextEncoding.decodeUtf8 (LazyBytes.toStrict (Aeson.encode value)))

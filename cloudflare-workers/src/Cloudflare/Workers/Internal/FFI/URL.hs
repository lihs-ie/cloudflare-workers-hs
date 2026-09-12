module Cloudflare.Workers.Internal.FFI.URL (
    requestURLText,
) where

import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

import Cloudflare.Workers.Internal.FFI.Text (jsValToText)

requestURLText :: JSVal -> IO Text
requestURLText requestJSValue = do
    urlJSValue <- jsRequestURL requestJSValue
    jsValToText urlJSValue

foreign import javascript unsafe "$1.url"
    jsRequestURL :: JSVal -> IO JSVal

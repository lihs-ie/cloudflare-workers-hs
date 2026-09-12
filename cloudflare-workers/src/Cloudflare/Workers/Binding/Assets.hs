-- | Fetch bundled static assets using the native Assets binding. Asset routing,
-- content types, conditional requests and bodies remain owned by the platform.
module Cloudflare.Workers.Binding.Assets (Assets(..), AssetsError(..), assetsFetch) where

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Internal.FFI.ServiceBinding (serviceBindingFetchViaFFI)
import Control.Exception (Exception, throwIO)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

newtype Assets = Assets JSVal
newtype AssetsError = AssetsFetchFailed Text deriving stock (Show, Eq)
instance Exception AssetsError

assetsFetch :: Assets -> Request -> IO Response
assetsFetch (Assets binding) request = do
    outcome <- serviceBindingFetchViaFFI binding request
    either (throwIO . AssetsFetchFailed) pure outcome

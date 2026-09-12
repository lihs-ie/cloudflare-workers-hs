module Cloudflare.Workers.Bundle (
    BundleManifest (..),
) where

import Data.Text (Text)

data BundleManifest = BundleManifest
    { bundleManifestEntryPoint :: Text
    , budnleManifestWasmPath :: Text
    }
    deriving stock (Show, Eq)

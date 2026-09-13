{-# LANGUAGE DeriveAnyClass #-}

module Minimal.API (API, Routes (..), Health (..)) where

import Data.Aeson (ToJSON)
import Data.Text (Text)
import GHC.Generics (Generic)
import Servant.API

newtype Health = Health {status :: Text}
    deriving stock (Eq, Show, Generic)
    deriving anyclass (ToJSON)

newtype Routes mode = Routes
    {health :: mode :- "health" :> Get '[JSON] Health}
    deriving stock (Generic)

type API = NamedRoutes Routes

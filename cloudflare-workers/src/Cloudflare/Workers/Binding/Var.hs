module Cloudflare.Workers.Binding.Var (
    Var (..),
    unVar,
) where

import Data.Text (Text)

newtype Var = Var Text
    deriving stock (Eq, Show)

unVar :: Var -> Text
unVar (Var value) = value

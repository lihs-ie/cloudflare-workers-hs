{-# LANGUAGE DataKinds #-}
{-# LANGUAGE DeriveGeneric #-}
module Support.Generic.Routes (Routes(..)) where
import GHC.Generics (Generic)
import Servant.API (Get, PlainText, (:>))
import Servant.API.Generic ((:-))
import Data.Text (Text)
data Routes mode = Routes
  { greeting :: mode :- "greeting" :> Get '[PlainText] Text
  , farewell :: mode :- "farewell" :> Get '[PlainText] Text
  } deriving stock Generic

module Cloudflare.Workers.Binding.D1 (
    D1 (..),
    D1PreparedStatement (D1PreparedStatementSTUB),
    D1Value (..),
    D1AllResult (..),
    d1Prepare,
    d1Bind,
    d1All,
) where

import Data.ByteString (ByteString)
import Data.Text (Text)

data D1 = D1STUB
    deriving stock (Show, Eq)

data D1PreparedStatement = D1PreparedStatementSTUB
    deriving stock (Show, Eq)

data D1Value
    = D1Null
    | D1Integer Integer
    | D1Real Double
    | D1Text Text
    | D1Blob ByteString
    deriving stock (Show, Eq)

data D1AllResult = D1AllResult
    { d1AllResultResults :: [[(Text, D1Value)]]
    , d1AllResultSuccess :: Bool
    }
    deriving stock (Show, Eq)

d1Prepare :: D1 -> Text -> IO D1PreparedStatement
d1Prepare _db _sql = pure D1PreparedStatementSTUB

d1Bind :: D1PreparedStatement -> [D1Value] -> IO D1PreparedStatement
d1Bind statement _values = pure statement

d1All :: D1PreparedStatement -> IO D1AllResult
d1All _statement =
    pure
        D1AllResult
            { d1AllResultResults = []
            , d1AllResultSuccess = True
            }

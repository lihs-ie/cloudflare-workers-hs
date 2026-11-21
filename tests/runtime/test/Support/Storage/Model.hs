module Support.Storage.Model (Operation (..), operations, expected) where

import Data.Aeson (ToJSON (..), Value (..), object, (.=))
import Data.Map.Strict qualified as Map
import Data.Text (Text)
import Hedgehog (Gen)
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range

data Operation = Put Text [Int] | Get Text | Delete Text | Transaction Text [Int]
    deriving (Show, Eq)

instance ToJSON Operation where
    toJSON operation = case operation of
        Put key bytes -> fields "put" key bytes
        Get key -> fields "get" key []
        Delete key -> fields "delete" key []
        Transaction key bytes -> fields "transaction" key bytes
      where
        fields :: Text -> Text -> [Int] -> Value
        fields command key bytes = object ["command" .= command, "key" .= key, "bytes" .= bytes]

operations :: Gen [Operation]
operations =
    Gen.list (Range.linear 1 10) $
        Gen.choice
            [ Put <$> key <*> bytes
            , Get <$> key
            , Delete <$> key
            , Transaction <$> key <*> bytes
            ]
  where
    key = Gen.element ["a", "b", "日本語"]
    bytes = Gen.list (Range.linear 0 16) (Gen.int (Range.linear 0 255))

expected :: [Operation] -> [Value]
expected = go Map.empty
  where
    go _ [] = []
    go state (operation : rest) = case operation of
        Put key bytes -> Null : go (Map.insert key bytes state) rest
        Transaction key bytes -> Null : go (Map.insert key bytes state) rest
        Get key -> maybe Null toJSON (Map.lookup key state) : go state rest
        Delete key -> Bool (Map.member key state) : go (Map.delete key state) rest

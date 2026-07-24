module Cloudflare.Workers.Binding.KV (
    KV (..),
    kvGet,
    kvPut,
    kvDelete,
    kvList,
) where

import Data.ByteString (ByteString)
import Data.Text (Text)

data KV = KVSTUB
    deriving stock (Show, Eq)

kvGet :: KV -> Text -> IO (Maybe ByteString)
kvGet _kv _key = pure Nothing

kvPut :: KV -> Text -> ByteString -> IO ()
kvPut _kv _key _value = pure ()

kvDelete :: KV -> Text -> IO ()
kvDelete _kv _key = pure ()

kvList :: KV -> IO [Text]
kvList _kv = pure []

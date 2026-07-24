module Cloudflare.Workers.Binding.R2 () where

import Data.ByteString (ByteString)
import Data.Text (Text)

data R2Bucket = R2BucketSTUB
    deriving stock (Show, Eq)

data R2Object = R2Object
    { r2ObjectKey :: Text
    , r2ObjectBody :: ByteString
    }
    deriving stock (Show, Eq)

r2Put :: R2Bucket -> Text -> ByteString -> IO ()
r2Put _bucket _key _body = pure ()

-- ...
r2Get :: R2Bucket -> Text -> IO (Maybe R2Object)
r2Get _bucket _key = pure Nothing

-- ...
r2List :: R2Bucket -> IO [Text]
r2List _bucket = pure []

-- ...
r2Delete :: R2Bucket -> Text -> IO ()
r2Delete _bucket _key = pure ()

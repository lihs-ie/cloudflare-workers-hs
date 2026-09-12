module Servant.Cloudflare.Workers.ContentType (
    -- * Re-exported from @servant@ core (Category A, not redefined)
    AcceptHeader (..),
    AllCTRender (..),
    AllCTUnrender (..),
    AllMime (..),
    canHandleAcceptH,

    -- * This module's own negotiation entry points
    acceptCheck,
    getAcceptHeader,
    getContentTypeHeader,
) where

import Cloudflare.Workers.HTTP (Request (requestHeaders))
import Cloudflare.Workers.Headers (headerLookup)
import Data.ByteString.Lazy qualified as LazyByteString
import Data.Maybe (fromMaybe)
import Data.Proxy (Proxy)
import Data.Text.Encoding qualified as TextEncoding
import Servant.API.ContentTypes (
    AcceptHeader (..),
    AllCTRender (..),
    AllCTUnrender (..),
    AllMime (..),
    canHandleAcceptH,
 )
import Servant.Cloudflare.Workers.Error (err406)
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (DelayedIO, delayedFail)

getAcceptHeader :: Request -> AcceptHeader
getAcceptHeader request =
    AcceptHeader (TextEncoding.encodeUtf8 (fromMaybe "*/*" (headerLookup "Accept" (requestHeaders request))))

getContentTypeHeader :: Request -> LazyByteString.ByteString
getContentTypeHeader request =
    LazyByteString.fromStrict
        (TextEncoding.encodeUtf8 (fromMaybe "application/octet-stream" (headerLookup "Content-Type" (requestHeaders request))))

acceptCheck :: (AllMime list) => Proxy list -> AcceptHeader -> DelayedIO ()
acceptCheck proxy acceptHeader
    | canHandleAcceptH proxy acceptHeader = pure ()
    | otherwise = delayedFail err406

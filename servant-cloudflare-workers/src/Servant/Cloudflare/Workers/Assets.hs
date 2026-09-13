-- | Serve an API inside reserved path namespaces and native assets everywhere
-- else. Routing is decided before running the API: its errors are never used
-- as a signal to retry a request against static files.
module Servant.Cloudflare.Workers.Assets (serveWithAssets) where

import Cloudflare.Workers.Binding.Assets (Assets, assetsFetch)
import Cloudflare.Workers.HTTP (Request, Response, requestURL)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Cloudflare.Workers.URL (urlPathRaw)
import Data.List (isPrefixOf)
import Data.Proxy (Proxy)
import Data.Text (Text)
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal.Router (splitPathSegments)

-- | Prefixes are decoded path segments, e.g. @[["api"], ["admin"]]@.
-- Matching uses the same decoding as Servant routing and segment boundaries,
-- so @/apiary@ does not match @["api"]@. An empty prefix reserves all paths;
-- an empty list reserves none. The full request reaches the selected handler.
-- Native assets errors propagate to the caller's exception middleware.
serveWithAssets ::
    HasWorkerServer api context =>
    [[Text]] -> Assets -> Proxy api -> Context context -> Server api env ->
    Request -> WorkersExecutionContext -> env -> IO Response
serveWithAssets reserved assets api context server request execution env
    | any (`isPrefixOf` segments) reserved =
        serveWithContext api context server request execution env
    | otherwise = assetsFetch assets request
  where
    segments = splitPathSegments (urlPathRaw (requestURL request))

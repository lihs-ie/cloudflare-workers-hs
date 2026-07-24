module Cloudflare.Workers.Entrypoint.Fetch (
    FetchHandler,
    JSFetchExport,
    createFetchHandler,
) where

import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Reactor (Context)

data JSFetchExport = JSFetchExportSTUB

{- | @env@ is the binding environment threaded to the handler
("Cloudflare.Workers.Env")
-}
type FetchHandler env = Request -> env -> Context -> IO Response

createFetchHandler :: FetchHandler env -> IO JSFetchExport
createFetchHandler _handler = pure JSFetchExportSTUB

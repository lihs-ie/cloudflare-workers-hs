module Support.Runtime.QuickstartBoundaries (managementFetch, leaseProbe) where

import Cloudflare.Workers.Binding.D1 (D1(..))
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace(..))
import Quickstart.Background.Coordinator (withLease)
import Cloudflare.Workers.Internal.FFI.Text (textToJSVal)
import Control.Exception (try, SomeException, throwIO, displayException)
import Data.Aeson (encode, object, (.=))
import Data.Text.Encoding (decodeUtf8)
import Data.ByteString.Lazy qualified as Lazy
import Data.IORef
import Data.Proxy (Proxy(..))
import Data.Text qualified as T
import Data.Time (UTCTime(..), fromGregorian)
import GHC.Wasm.Prim (JSVal)
import Quickstart.Management qualified as Management
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()

-- Deterministic identifiers and clock only; statements execute against native D1.
-- mode 0 collides once then succeeds; mode 1 exhausts all eight attempts.
managementFetch :: JSVal -> Int -> JSVal -> JSVal -> IO JSVal
managementFetch database mode request context = do
  attempts <- newIORef (0 :: Int)
  let next = atomicModifyIORef' attempts $ \n -> (n + 1, if mode == 1 || n == 0 then "collision" else "fresh-" <> T.pack (show n))
      environment = Management.ManagementEnv (D1 database) "boundary-admin" (pure (UTCTime (fromGregorian 2026 9 11) 0)) next
  createFetchHandler (\received (_ :: BindingEnv '[] '[] '[]) execution ->
    serveWithContext (Proxy @Management.API) EmptyContext Management.server received execution environment) request database context

-- Controlled transport faults enter through a fixture namespace. Haskell owns
-- acquisition, renewal and bracket cleanup; all exceptions stay in Haskell.
leaseProbe :: JSVal -> Int -> IO JSVal
leaseProbe namespace mode = do
  ran <- newIORef False
  result <- try @SomeException $ withLease (DurableObjectNamespace namespace) "boundary-export" $ \renew -> do
    writeIORef ran True
    if mode == 1 then throwIO (userError "action_failed") else renew
  didRun <- readIORef ran
  textToJSVal $ decodeUtf8 $ Lazy.toStrict $ encode $ object
    [ "ran" .= didRun
    , "ok" .= either (const False) (const True) result
    , "error" .= either displayException (const "") result
    ]

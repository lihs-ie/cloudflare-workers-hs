module Support.Runtime.MiddlewareExtra (middlewareExtraProbe) where
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Middleware (withStructuredLoggingUsing, withStructuredLogging, formatRequestIdentifierUUIDv4)
import Cloudflare.Workers.Observability
import Control.Monad (forM)
import Control.Exception (try, throwIO, IOException)
import Data.Aeson (object, (.=), encode)
import Data.IORef
import Control.Concurrent.MVar
import Support.Cloudflare.Workers.ObservabilityContracts (observabilityContracts)
import GHC.Wasm.Prim (JSVal)

-- Actual request/context conversion and middleware; only the handler failure
-- and log sink are controlled. Returned records are obtained after deferred work.
middlewareExtraProbe :: JSVal -> JSVal -> IO JSVal
middlewareExtraProbe request context = do
  observabilityContracts
  records <- newIORef []
  completed <- newEmptyMVar
  let sink record = do
        count <- atomicModifyIORef' records (\values -> let updated = values ++ [record] in (updated, length updated))
        if count == 4 then putMVar completed () else pure ()
      handler received (_ :: BindingEnv '[] '[] '[]) execution = do
        let native = requestPath received == "/middleware-native" || requestPath received == "/middleware-sampled"
            config = if requestPath received == "/middleware-sampled" then LoggerConfig LogInfo 0 else defaultLoggerConfig
            logging = if native then withStructuredLogging config else withStructuredLoggingUsing sink
        outcome <- try @IOException $ logging
          (\_ _ _ -> throwIO (userError "middleware-known-failure")) received () execution
        -- A second invocation must remain usable after rethrow.
        _ <- logging
          (\_ _ _ -> pure (createResponse (Status 204) (headersFromList []) (ResponseBodyBytes ""))) received () execution
        registrationReceipts <- if requestPath received == "/middleware-native"
          then forM [LogDebug, LogWarn] $ \level -> deferredSinkExceptErrors execution (emitLog defaultLoggerConfig)
            (LogRecord level "native-level-check" Nothing Nothing Nothing Nothing Nothing Nothing "level dispatch")
          else pure []
        if native then pure () else takeMVar completed
        current <- readIORef records
        pure $ createResponse (Status 200) (headersFromList [("Content-Type","application/json")])
          (ResponseBodyLazyBytes (encode (object ["rejected" .= either (const True) (const False) outcome, "records" .= current, "registrationReceipts" .= map show registrationReceipts, "formattedIdentifiers" .= [formatRequestIdentifierUUIDv4 0 0, formatRequestIdentifierUUIDv4 maxBound maxBound]])))
  createFetchHandler handler request request context

{-# LANGUAGE CPP #-}
{-# LANGUAGE DataKinds #-}

module Support.Runtime.AccessRoutes (runAccessRouteScenarios
#if defined(wasi_HOST_OS)
  , accessRoutesProbe
#endif
  ) where


#if defined(wasi_HOST_OS)
import Cloudflare.Workers.Entrypoint.Fetch (createFetchHandler)
import Cloudflare.Workers.Env (BindingEnv)
import Data.Aeson qualified as Aeson
import GHC.Wasm.Prim (JSVal)
#endif
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Control.Exception (throwIO)
import Control.Monad (unless)
import Control.Monad.IO.Class (liftIO)
import Data.ByteString.Lazy qualified as LBS
import Data.IORef (modifyIORef', newIORef, readIORef, writeIORef)
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Servant.API (Get, PlainText, (:>), (:<|>) (..))
import Servant.Cloudflare.Workers.Access
import Servant.Cloudflare.Workers.Access.Combinator
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()

type ServiceRoute = ZeroTrustService :> Get '[PlainText] Text

-- | Exercise the same authentication boundary on host and real WASM requests.
-- Each failure must remain opaque and fatal, without dispatching any handler.
runAccessRouteScenarios :: Request -> WorkersExecutionContext -> IO [Text]
runAccessRouteScenarios baseRequest executionContext = do
    -- The shared response oracle must normalize both native strict bytes and
    -- the lazy bytes emitted by the Servant renderer.
    expect "strict authentication response" =<< body
        (createResponse (Status 200) (headersFromList []) (ResponseBodyBytes "strict authentication response"))
    denied <- mapM runDenied
        [ ("service-missing-header", False, pure (Right identity))
        , ("service-verifier-left", True, pure (Left AccessErrorInvalidSignature))
        , ("service-verifier-throws", True, throwIO (userError "private verifier detail"))
        , ("service-verifier-bottom-result", True, pure (error "private lazy result"))
        , ("service-verifier-bottom-identity", True, pure (Right (error "private lazy identity")))
        ]
    accepted <- runAccepted False
    nested <- runAccepted True
    userThenService <- runCombined False
    serviceThenUser <- runCombined True
    pure (denied <> [accepted, nested, userThenService, serviceThenUser])
  where
    identity = AccessServiceClaims "client.access" ["audience"] "issuer" 9999999999
    request assertion = baseRequest
        { requestMethodField = GET
        , requestHeaders = headersFromList [("cF-aCcEsS-jWt-AsSeRtIoN", "service-token") | assertion]
        }
    runDenied (label, hasAssertion, verification) = do
        verifierCalls <- newIORef (0 :: Int)
        handlerCalls <- newIORef (0 :: Int)
        fallbackCalls <- newIORef (0 :: Int)
        let verifier = AccessServiceVerifier $ \assertion -> do
                expect "service-token" assertion
                modifyIORef' verifierCalls (+ 1)
                verification
            handler _ = liftIO (modifyIORef' handlerCalls (+ 1)) >> pure "secret service content"
            fallback = liftIO (modifyIORef' fallbackCalls (+ 1)) >> pure "public fallback"
        response <- serveWithContext (Proxy @(ServiceRoute :<|> Get '[PlainText] Text))
            (verifier :. EmptyContext) (handler :<|> fallback) (request hasAssertion) executionContext ()
        reference <- serveWithContext (Proxy @ServiceRoute)
            (AccessServiceVerifier (const (pure (Left AccessErrorInvalidSignature))) :. EmptyContext)
            (const (pure "unreachable")) (request False) executionContext ()
        expect 401 (statusCode (responseStatus response))
        expect (responseHeaders reference) (responseHeaders response)
        referenceBody <- body reference
        expect referenceBody =<< body response
        expect (if hasAssertion then 1 else 0) =<< readIORef verifierCalls
        expect 0 =<< readIORef handlerCalls
        expect 0 =<< readIORef fallbackCalls
        pure label
    runAccepted nested = do
        verifierCalls <- newIORef (0 :: Int)
        handlerCalls <- newIORef (0 :: Int)
        userVerifierCalls <- newIORef (0 :: Int)
        seenIdentity <- newIORef Nothing
        let verifier = AccessServiceVerifier $ \assertion -> do
                expect "service-token" assertion
                modifyIORef' verifierCalls (+ 1)
                pure (Right identity)
            userVerifier = AccessVerifier $ \_ -> do
                modifyIORef' userVerifierCalls (+ 1)
                pure (Left AccessErrorInvalidSignature)
            handler claims = do
                liftIO $ do
                    modifyIORef' handlerCalls (+ 1)
                    writeIORef seenIdentity (Just claims)
                pure (accessServiceClaimsIdentifier claims)
        response <- if nested
            then serveWithContext (Proxy @ServiceRoute)
                (("unrelated context" :: Text) :. userVerifier :. verifier :. EmptyContext)
                handler (request True) executionContext ()
            else serveWithContext (Proxy @ServiceRoute) (verifier :. EmptyContext)
                handler (request True) executionContext ()
        expect 200 (statusCode (responseStatus response))
        expect "client.access" =<< body response
        expect 1 =<< readIORef verifierCalls
        expect 1 =<< readIORef handlerCalls
        expect 0 =<< readIORef userVerifierCalls
        expect (Just identity) =<< readIORef seenIdentity
        pure (if nested then "service-nested-context-consumed" else "service-verified-identity")

    runCombined serviceFirst = do
        -- Reject each identity independently. The opaque Left payload must not
        -- be forced merely to turn authentication failure into a 401 response.
        mapM_ (runCombinedResult serviceFirst) [(True, True), (False, True), (True, False)]
        pure (if serviceFirst then "service-then-user-context" else "user-then-service-context")
    runCombinedResult serviceFirst (acceptUser, acceptService) = do
        userCalls <- newIORef (0 :: Int)
        serviceCalls <- newIORef (0 :: Int)
        handlerCalls <- newIORef (0 :: Int)
        seenIdentities <- newIORef Nothing
        let userIdentity = AccessClaims "member@example.test" "subject" ["audience"] "issuer" 9999999999
            userVerifier = AccessVerifier $ \assertion -> do
                expect "service-token" assertion
                modifyIORef' userCalls (+ 1)
                pure (if acceptUser then Right userIdentity else Left (error "opaque user error must remain lazy"))
            serviceVerifier = AccessServiceVerifier $ \assertion -> do
                expect "service-token" assertion
                modifyIORef' serviceCalls (+ 1)
                pure (if acceptService then Right identity else Left (error "opaque service error must remain lazy"))
            handler userClaims serviceClaims = do
                liftIO $ do
                    modifyIORef' handlerCalls (+ 1)
                    writeIORef seenIdentities (Just (userClaims, serviceClaims))
                pure (accessClaimsEmail userClaims <> ":" <> accessServiceClaimsIdentifier serviceClaims)
            context = ("unrelated context" :: Text) :. userVerifier :. serviceVerifier :. EmptyContext
        response <- if serviceFirst
            then serveWithContext (Proxy @(ZeroTrustService :> ZeroTrust :> Get '[PlainText] Text))
                context (flip handler) (request True) executionContext ()
            else serveWithContext (Proxy @(ZeroTrust :> ZeroTrustService :> Get '[PlainText] Text))
                context handler (request True) executionContext ()
        if acceptUser && acceptService
            then do
                expect 200 (statusCode (responseStatus response))
                expect "member@example.test:client.access" =<< body response
                expect (Just (userIdentity, identity)) =<< readIORef seenIdentities
                expect 1 =<< readIORef handlerCalls
                expect 1 =<< readIORef userCalls
                expect 1 =<< readIORef serviceCalls
            else do
                expect 401 (statusCode (responseStatus response))
                expect Nothing =<< readIORef seenIdentities
                expect 0 =<< readIORef handlerCalls
                expect (if serviceFirst && not acceptService then 0 else 1) =<< readIORef userCalls
                expect (if not serviceFirst && not acceptUser then 0 else 1) =<< readIORef serviceCalls
                reference <- serveWithContext (Proxy @ServiceRoute)
                    (serviceVerifier :. EmptyContext) (const (pure "unreachable"))
                    (request False) executionContext ()
                referenceBody <- body reference
                expect referenceBody =<< body response
                expect (responseHeaders reference) (responseHeaders response)

body :: Response -> IO LBS.ByteString
body response = case responseBody response of
    ResponseBodyBytes bytes -> pure (LBS.fromStrict bytes)
    ResponseBodyLazyBytes bytes -> pure bytes
    _ -> throwIO (userError "expected buffered authentication response")

expect :: (Eq value, Show value) => value -> value -> IO ()
expect expected actual = unless (expected == actual) $
    throwIO (userError ("Access route contract: expected " <> show expected <> ", got " <> show actual))


#if defined(wasi_HOST_OS)
-- | Reuse the production request adapter; return a native JSON Response.
accessRoutesProbe :: JSVal -> JSVal -> IO JSVal
accessRoutesProbe requestValue contextValue =
  createFetchHandler handler requestValue contextValue contextValue
  where
    handler :: Request -> BindingEnv '[] '[] '[] -> WorkersExecutionContext -> IO Response
    handler request _ context = do
      names <- runAccessRouteScenarios request context
      pure (createResponse (Status 200) (headersFromList [("Content-Type", "application/json")]) (ResponseBodyLazyBytes (Aeson.encode names)))

#endif

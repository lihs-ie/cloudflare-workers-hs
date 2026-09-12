{-# LANGUAGE DataKinds #-}

module Servant.Cloudflare.Workers.Access.CombinatorSpec (spec) where

import Cloudflare.Workers.HTTP (Request (requestHeaders), ResponseBody (..), Status (..), createResponse, responseStatus, statusCode)
import Cloudflare.Workers.Headers (headersFromList)
import Control.Exception (throwIO)
import Control.Monad.IO.Class (liftIO)
import Data.IORef
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Servant.API
import Servant.Cloudflare.Workers.Access
import Servant.Cloudflare.Workers.Access.Combinator
import Servant.Cloudflare.Workers.Server
import Servant.Cloudflare.Workers.Server.Internal ()
import Support.Runtime.AccessRoutes (runAccessRouteScenarios)
import Support.Fixtures.Combinator
import Test.Syd

type Protected = ZeroTrust :> Get '[PlainText] Text

spec :: Spec
spec = describe "ZeroTrust authentication boundary" $ do
    it "normalizes strict buffered output in the shared response oracle" $
        responseBytes (createResponse (Status 200) (headersFromList []) (ResponseBodyBytes "strict response")) `shouldBe` "strict response"
    it "shares nine service authentication scenarios with real WASM" $ do
        scenarios <- runAccessRouteScenarios request executionContext
        scenarios `shouldBe`
            [ "service-missing-header", "service-verifier-left", "service-verifier-throws"
            , "service-verifier-bottom-result", "service-verifier-bottom-identity"
            , "service-verified-identity", "service-nested-context-consumed"
            , "user-then-service-context", "service-then-user-context"
            ]
    it "rejects a missing assertion without calling the verifier or handler" $ do
        verifierCalled <- newIORef False
        handlerCalled <- newIORef False
        response <-
            serveWithContext
                (Proxy @Protected)
                (AccessVerifier (\_ -> writeIORef verifierCalled True >> pure (Right claims)) :. EmptyContext)
                (\_ -> liftIO (writeIORef handlerCalled True) >> pure "protected")
                request
                executionContext
                ()
        statusCode (responseStatus response) `shouldBe` 401
        readIORef verifierCalled `shouldReturn` False
        readIORef handlerCalled `shouldReturn` False
    it "passes the exact assertion to verification and verified claims to the handler" $ do
        seenAssertion <- newIORef Nothing
        seenClaims <- newIORef Nothing
        response <-
            serveWithContext
                (Proxy @Protected)
                (AccessVerifier (\assertion -> writeIORef seenAssertion (Just assertion) >> pure (Right claims)) :. EmptyContext)
                (\identity -> liftIO (writeIORef seenClaims (Just identity)) >> pure (accessClaimsEmail identity))
                request{requestHeaders = headersFromList [("cf-access-jwt-assertion", "signed-token")]}
                executionContext
                ()
        statusCode (responseStatus response) `shouldBe` 200
        responseBytes response `shouldBe` "member@example.test"
        readIORef seenAssertion `shouldReturn` Just "signed-token"
        readIORef seenClaims `shouldReturn` Just claims
    mapM_
        ( \(label, verification) ->
            it label $ do
                protectedCalled <- newIORef False
                fallbackCalled <- newIORef False
                response <-
                    serveWithContext
                        (Proxy @(Protected :<|> Get '[PlainText] Text))
                        (AccessVerifier (const verification) :. EmptyContext)
                        ( (\_ -> liftIO (writeIORef protectedCalled True) >> pure "protected")
                            :<|> (liftIO (writeIORef fallbackCalled True) >> pure "public fallback")
                        )
                        request{requestHeaders = headersFromList [("Cf-Access-Jwt-Assertion", "secret-token")]}
                        executionContext
                        ()
                statusCode (responseStatus response) `shouldBe` 401
                readIORef protectedCalled `shouldReturn` False
                readIORef fallbackCalled `shouldReturn` False
                -- Neither exception messages nor token text may escape in the response.
                reference <-
                    serveWithContext
                        (Proxy @Protected)
                        (AccessVerifier (const (pure (Left AccessErrorInvalidSignature))) :. EmptyContext)
                        (\_ -> pure "unreachable")
                        request
                        executionContext
                        ()
                responseBytes response `shouldBe` responseBytes reference
        )
        [ ("rejects invalid signatures fatally without trying a public fallback", pure (Left AccessErrorInvalidSignature))
        , ("rejects expiration fatally", pure (Left AccessErrorExpored))
        , ("rejects audience mismatch fatally", pure (Left AccessErrorAudienceMismach))
        , ("hides malformed claim details", pure (Left (AccessErrorMalformed "secret-token")))
        , ("turns verifier IO exceptions into fatal opaque 401", throwIO (userError "secret-token"))
        , ("forces a lazy verifier result inside the exception boundary", pure (error "secret-token"))
        , ("forces a lazy successful identity inside the exception boundary", pure (Right (error "secret-token")))
        ]

    it "service routes receive service claims and require an assertion" $ do
        let identity = AccessServiceClaims "client.access" ["audience"] "issuer" 9999999999
            context = AccessServiceVerifier (const (pure (Right identity))) :. EmptyContext
            handler = pure . accessServiceClaimsIdentifier
        accepted <- serveWithContext (Proxy @(ZeroTrustService :> Get '[PlainText] Text)) context handler
            request{requestHeaders = headersFromList [("Cf-Access-Jwt-Assertion", "service-token")]} executionContext ()
        statusCode (responseStatus accepted) `shouldBe` 200
        responseBytes accepted `shouldBe` "client.access"
        denied <- serveWithContext (Proxy @(ZeroTrustService :> Get '[PlainText] Text)) context handler request executionContext ()
        statusCode (responseStatus denied) `shouldBe` 401

{-# LANGUAGE OverloadedStrings #-}

-- | Routing and delayed-check contracts shared by host and real WASM callers.
module Support.Runtime.RouterInternals (runRouterInternals, runDelayedFailures, runForwardingContracts) where

import Cloudflare.Workers.HTTP (Request, Response, ResponseBody (..), Status (..), createResponse, requestMethod, responseStatus)
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Reactor (WorkersExecutionContext)
import Control.Monad (unless, when, (>=>))
import Control.Monad.IO.Class (liftIO)
import Data.Functor ((<&>))
import Data.IORef (modifyIORef', newIORef, readIORef)
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Data.Typeable (typeRep)
import Servant.Cloudflare.Workers.Error
import Servant.Cloudflare.Workers.Server.Internal.Delayed
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (delayedFail, delayedFailFatal)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult
import Servant.Cloudflare.Workers.Server.Internal.Router

runRouterInternals :: Request -> WorkersExecutionContext -> IO [Text]
runRouterInternals request context =
    sequence
        [ check "static-root-markers" $ do
            mapM_ (routeStatus (leafRouter (const success)) >=> assertEqual 200) [[], [""]]
        , check "capture-choice" $ do
            let router =
                    choice
                        (CaptureRouter [] (leafRouter (const (failure err404))))
                        (CaptureRouter [] (leafRouter (\(value, ()) -> if value == "chosen" then success else failure err400)))
            routeStatus router ["chosen"] >>= assertEqual 200
        , check "capture-missing" $ do
            mapM_ (routeStatus (CaptureRouter [] (leafRouter (const success))) >=> assertEqual 404) [[], [""]]
        , check "capture-all-root-marker" $ do
            let router = CaptureAllRouter [] (leafRouter (\(values, ()) -> if values == ["tail"] then success else failure err400))
            routeStatus router ["", "tail"] >>= assertEqual 200
        , check "heterogeneous-choice" $ do
            let router =
                    choice
                        (RawRouter (const (failure err404)))
                        (Choice (pathRouter "other" (leafRouter (const success))) (CaptureRouter [] (leafRouter (const success))))
            routeStatus router ["chosen"] >>= assertEqual 200
        , check "path-splitting" $ do
            assertEqual [] (splitPathSegments "")
            assertEqual ["a b", "c"] (splitPathSegments "a%20b/c")
        , check "allow-missing-and-empty-values" $
            assertEqual
                [("Allow", "GET, POST")]
                (serverErrorHeaders (unionAllow err405 err405{serverErrorHeaders = [("Allow", " , GET, , GET, POST, ")]}))
        , check "failure-priority" $ do
            mapM_
                ( \(low, high) -> do
                    assertEqual True (worseHTTPCode low high)
                    assertEqual False (worseHTTPCode high low)
                )
                [(404, 405), (405, 401), (401, 415), (415, 406), (406, 500), (500, 400)]
            result <- runChoice [failure err400, failure err404] [] request context ()
            assertFailure err400 result
        , check "failure-tie-preserves-first" $ do
            let firstError = err400{serverErrorHeaders = [("X-Origin", "first")]}
            result <- runChoice [failure firstError, failure err400] [] request context ()
            assertFailure firstError result
        , check "later-fatal-error" $ do
            result <- runChoice [failure err400, \_ _ _ _ -> pure (FailFatal err404)] [] request context ()
            case result of
                FailFatal actual -> assertEqual err404 actual
                _ -> fail "expected fatal error"
        , check "accept-check-order" $ do
            calls <- newIORef ([] :: [Int])
            let delayed =
                    addAcceptCheck
                        (addAcceptCheck (emptyDelayed (Route (42 :: Int))) (liftIO (modifyIORef' calls (<> [1]))))
                        (liftIO (modifyIORef' calls (<> [2])))
            runDelayed delayed () request >>= assertEqual (Route 42)
            readIORef calls >>= assertEqual [1, 2]
        , check "accept-check-short-circuit" $ do
            calls <- newIORef (0 :: Int)
            let delayed =
                    addAcceptCheck
                        (addAcceptCheck (emptyDelayed (Route (42 :: Int))) (delayedFailFatal err400))
                        (liftIO (modifyIORef' calls (+ 1)))
            runDelayed delayed () request >>= assertEqual (FailFatal err400)
            readIORef calls >>= assertEqual 0
        , check "content-type-pairing" $ do
            let delayed =
                    addBodyCheck
                        (addBodyCheck (emptyDelayed (Route ((,) :: Int -> Int -> (Int, Int)))) (pure 10) (pure . (+ 1)))
                        (pure 20)
                        (pure . (+ 2))
            runDelayed delayed () request >>= assertEqual (Route (11, 22))
        , check "route-result-short-circuit" $ do
            let skipped _ = error "a failed route must not run the continuation" :: RouteResult Int
            assertEqual (Fail err400) (Fail err400 >>= skipped)
            assertEqual (FailFatal err401) (FailFatal err401 >>= skipped)
            assertEqual (Route (42 :: Int)) (Route 41 <&> (+ 1))
            assertEqual (Route (42 :: Int)) ((+ 1) <$> Route 41)
            assertEqual (Fail err400 :: RouteResult Int) (Fail err400 <*> error "failed function must not evaluate argument")
            assertEqual (FailFatal err401 :: RouteResult Int) (Route (+ 1) <*> FailFatal err401)
        , check "delayed-map-preserves-failure" $ do
            runDelayed ((+ 1) <$> emptyDelayed (Route (41 :: Int))) () request >>= assertEqual (Route 42)
            mapM_
                ( \failed ->
                    runDelayed
                        (error "mapping a failed server must not run" <$> emptyDelayed failed)
                        ()
                        request
                        >>= assertEqual failed
                )
                [Fail err400, FailFatal err401 :: RouteResult Int]
        , check "delayed-arguments-preserve-failed-server" $ do
            mapM_
                ( \failed -> do
                    let server = emptyDelayed failed
                        ignored = pure (error "failed server must not force checked argument" :: Int)
                        expected = case failed of
                            Fail e -> Fail e
                            FailFatal e -> FailFatal e
                            Route _ -> error "failure fixture required"
                    runDelayed (addCapture server (const ignored)) ((), ()) request >>= assertEqual expected
                    runDelayed (addParameterCheck server ignored) () request >>= assertEqual expected
                    runDelayed (addHeaderCheck server ignored) () request >>= assertEqual expected
                    runDelayed (addAuthCheck server ignored) () request >>= assertEqual expected
                    runDelayed (addBodyCheck server (pure ()) (const ignored)) () request >>= assertEqual expected
                    runDelayed (passToServer server (const (error "failed server must not extract"))) () request >>= assertEqual expected
                )
                [Fail err400, FailFatal err401 :: RouteResult (Int -> Int)]
        , check "capture-hints-merge-without-duplicates" $ do
            let firstHint = CaptureHint "first" (typeRep (Proxy :: Proxy Int))
                secondHint = CaptureHint "second" (typeRep (Proxy :: Proxy Text))
                left = CaptureRouter [firstHint] (leafRouter (const success))
                right = CaptureRouter [firstHint, secondHint] (leafRouter (const success))
            case choice left right of
                CaptureRouter hints _ -> assertEqual [firstHint, secondHint] hints
                _ -> fail "capture routers must merge"
        , check "choice-success-skips-later-application" $ do
            calls <- newIORef (0 :: Int)
            let later _ _ _ _ = modifyIORef' calls (+ 1) >> pure (Fail err400)
            result <- runChoice [success, later] [] request context ()
            case result of
                Route response -> assertEqual (Status 200) (responseStatus response)
                _ -> fail "expected first successful route"
            readIORef calls >>= assertEqual 0
        , check "choice-prefers-later-higher-priority" $ do
            result <- runChoice [failure err404, failure err400] [] request context ()
            assertFailure err400 result
        , check "request-extraction" $ do
            runDelayed (passToServer (emptyDelayed (Route id)) requestMethod) () request >>= assertEqual (Route (requestMethod request))
            runDelayed
                ( passToServer
                    (emptyDelayed (FailFatal err400 :: RouteResult (Int -> Int)))
                    (\_ -> error "failed server must not extract request")
                )
                ()
                request
                >>= assertEqual (FailFatal err400)
        ]
  where
    check name action = action >> pure name
    success :: RoutingApplication ()
    success _ _ _ _ = pure (Route (createResponse (Status 200) (headersFromList []) (ResponseBodyBytes "ok")))
    failure err _ _ _ _ = pure (Fail err)
    routeStatus router segments = do
        result <- runRouter router segments request context ()
        pure $ case result of
            Route response -> let Status value = responseStatus response in value
            Fail err -> serverErrorStatusCode err
            FailFatal err -> serverErrorStatusCode err

assertEqual :: (Eq a, Show a) => a -> a -> IO ()
assertEqual expected actual = unless (expected == actual) (fail ("expected " <> show expected <> ", got " <> show actual))

assertFailure :: ServerError -> RouteResult Response -> IO ()
assertFailure expected result = case result of
    Fail actual -> assertEqual expected actual
    _ -> fail "expected recoverable error"

-- | Check each failure boundary independently; subsequent normal calls recover.
runDelayedFailures :: Request -> IO [Text]
runDelayedFailures request =
    sequence
        [scenario fatal stop | fatal <- [False, True], stop <- stages]
  where
    stages = ["capture", "method", "auth", "accept", "content", "params", "headers", "body"]
    scenario fatal stop = do
        trace <- newIORef []
        let step name = do
                liftIO (modifyIORef' trace (<> [name]))
                when (name == stop) $ if fatal then delayedFailFatal err400 else delayedFail err400
            delayed =
                Delayed
                    (const (step "capture"))
                    (step "method")
                    (step "auth")
                    (step "accept")
                    (step "content")
                    (step "params")
                    (step "headers")
                    (const (step "body"))
                    (\_ _ _ _ _ _ -> Route (42 :: Int))
        runDelayed delayed () request >>= assertEqual (if fatal then FailFatal err400 else Fail err400)
        readIORef trace >>= assertEqual (takeWhile (/= stop) stages <> [stop])
        runDelayed (emptyDelayed (Route (42 :: Int))) () request >>= assertEqual (Route 42)
        pure ((if fatal then "fatal-" else "recoverable-") <> stop)

-- | Preserve all checked values when composing delayed request checks.
runForwardingContracts :: Request -> IO [[Int]]
runForwardingContracts request =
    sequence
        [ check (fmap ($ 60) base) 10
        , check (addCapture base (pure . (+ 1))) (59, 10)
        , check (addParameterCheck base (pure 60)) 10
        , check (addHeaderCheck base (pure 60)) 10
        , check (addAuthCheck base (pure 60)) 10
        , check (addBodyCheck base (pure 30) (pure . (* 2))) 10
        , check (passToServer base (const 60)) 10
        ]
  where
    base :: Delayed Int (Int -> [Int])
    base =
        Delayed
            (pure . (+ 1))
            (pure ())
            (pure 14)
            (pure ())
            (pure 5)
            (pure 12)
            (pure 13)
            (pure . (* 3))
            ( \capture params headers auth body req ->
                Route
                    (\new -> [capture, params, headers, auth, body, if requestMethod req == requestMethod request then 1 else 0, new])
            )
    check :: Delayed env [Int] -> env -> IO [Int]
    check delayed env = do
        result <- runDelayed delayed env request
        case result of
            Route values -> do
                unless (values == [11, 12, 13, 14, 15, 1, 60]) (fail "delayed forwarding changed a checked value")
                pure values
            _ -> fail "delayed forwarding unexpectedly failed"

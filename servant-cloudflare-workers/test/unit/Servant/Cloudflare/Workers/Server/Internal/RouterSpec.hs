{-# LANGUAGE OverloadedStrings #-}
module Servant.Cloudflare.Workers.Server.Internal.RouterSpec (spec) where
import Test.Syd hiding (context)
import Data.IORef
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Servant.Cloudflare.Workers.Server.Internal.Router
import Servant.Cloudflare.Workers.Server.Internal.RouteResult
import Servant.Cloudflare.Workers.Error
import Support.Router.Applications (failure, success, run)
import Support.Runtime.RouterInternals (runRouterInternals, runForwardingContracts, runDelayedFailures)
import Support.HTTP.Fixtures
spec :: Spec
spec = do
  describe "splitPathSegments" $ mapM_ (\(input, expected) -> it (show input) $ splitPathSegments input `shouldBe` expected)
    [("",[]),("/",[""]),("/a/",["a",""]),("/a//b",["a","","b"]),("/a%2Fb",["a/b"]),("/a+b",["a+b"])]
  describe "failure priority" $ mapM_ (\(low, high) -> it (show (low,high)) $ do
    worseHTTPCode low high `shouldBe` True
    worseHTTPCode high low `shouldBe` False) [(404,405),(405,401),(401,415),(415,406),(406,500),(500,400)]
  it "merges Allow values without duplicates and preserves other headers" $
    serverErrorHeaders (unionAllow err405{serverErrorHeaders=[("Allow","GET, POST"),("X-Test","yes")]} err405{serverErrorHeaders=[("Allow","POST, PUT")]})
      `shouldBe` [("Allow","GET, POST, PUT"),("X-Test","yes")]
  it "empty choice fails 404" $ run [] >>= (`shouldBe` Left err404)
  it "recoverable failure tries the next route" $ run [failure err404, success] >>= (`shouldBe` Right 200)
  it "fatal failure prevents later routes from running" $ do
    calls <- newIORef (0 :: Int)
    result <- run [\_ _ _ _ -> pure (FailFatal err400), \_ _ _ _ -> modifyIORef' calls (+1) >> pure (Fail err404)]
    result `shouldBe` Left err400
    readIORef calls `shouldReturn` 0
  it "success prevents later routes from running" $ do
    calls <- newIORef (0 :: Int)
    result <- run [success, \_ _ _ _ -> modifyIORef' calls (+1) >> pure (Fail err500)]
    result `shouldBe` Right 200
    readIORef calls `shouldReturn` 0
  it "selects the higher priority recoverable error" $
    run [failure err404, failure err400] >>= (`shouldBe` Left err400)
  it "merges method errors through choice" $
    run [failure err405{serverErrorHeaders=[("Allow","GET")]}, failure err405{serverErrorHeaders=[("Allow","POST")]}]
      >>= (`shouldBe` Left err405{serverErrorHeaders=[("Allow","GET, POST")]})
  describe "router traversal" $ do
    it "dispatches a static leaf through a path" $ do
      result <- runRouter (pathRouter "hello" (leafRouter (const success))) ["hello"] request context ()
      case result of
        Route response -> responseStatus response `shouldBe` Status 200
        _ -> expectationFailure "expected static route success"
    it "rejects an unknown static segment" $ do
      result <- runRouter (pathRouter "hello" (leafRouter (const success))) ["missing"] request context ()
      case result of
        Fail e -> e `shouldBe` err404
        _ -> expectationFailure "expected missing path failure"
    it "passes a captured segment to the leaf" $ do
      let router = CaptureRouter [] (leafRouter (\(segment,()) _ _ _ _ -> pure (Route (createResponse (Status 200) (headersFromList []) (ResponseBodyLazyBytes (if segment == "value" then "captured" else "wrong"))))))
      result <- runRouter router ["value"] request context ()
      case result of
        Route response -> bodyBytes response `shouldBe` "captured"
        _ -> expectationFailure "expected capture success"
    it "rejects missing capture" $ do
      result <- runRouter (CaptureRouter [] (leafRouter (const success))) [] request context ()
      case result of
        Fail e -> e `shouldBe` err404
        _ -> expectationFailure "expected missing capture failure"
    it "accepts empty capture-all" $ do
      let router = CaptureAllRouter [] (leafRouter (\(segments,()) -> if null segments then success else failure err400))
      result <- runRouter router [] request context ()
      case result of
        Route response -> responseStatus response `shouldBe` Status 200
        _ -> expectationFailure "expected empty capture-all success"
    it "combines static tables while retaining both paths" $ do
      let router = choice (pathRouter "one" (leafRouter (const success))) (pathRouter "two" (leafRouter (const success)))
      mapM_ (\segment -> do
        result <- runRouter router [segment] request context ()
        case result of
          Route response -> responseStatus response `shouldBe` Status 200
          _ -> expectationFailure "expected merged static path") ["one","two"]
    it "combines capture routers and falls through recoverable failures" $ do
      let router = choice (CaptureRouter [] (leafRouter (const (failure err404)))) (CaptureRouter [] (leafRouter (const success)))
      result <- runRouter router ["value"] request context ()
      case result of
        Route response -> responseStatus response `shouldBe` Status 200
        _ -> expectationFailure "expected merged capture success"
    it "walks heterogeneous nested choices" $ do
      let router = choice (RawRouter (const (failure err404))) (Choice (pathRouter "other" (leafRouter (const success))) (CaptureRouter [] (leafRouter (const success))))
      result <- runRouter router ["value"] request context ()
      case result of
        Route response -> responseStatus response `shouldBe` Status 200
        _ -> expectationFailure "expected nested choice success"
    it "rejects an empty capture segment" $ do
      result <- runRouter (CaptureRouter [] (leafRouter (const success))) [""] request context ()
      case result of
        Fail e -> e `shouldBe` err404
        _ -> expectationFailure "expected empty capture failure"
    it "drops the root marker from capture-all" $ do
      let router = CaptureAllRouter [] (leafRouter (\(segments,()) -> if segments == ["tail"] then success else failure err400))
      result <- runRouter router ["","tail"] request context ()
      case result of
        Route response -> responseStatus response `shouldBe` Status 200
        _ -> expectationFailure "expected root marker removal"
    it "runs static leaves with no segments" $ do
      result <- runRouter (leafRouter (const success)) [] request context ()
      case result of
        Route response -> responseStatus response `shouldBe` Status 200
        _ -> expectationFailure "expected root leaf"

  it "keeps the first error when recoverable priorities tie" $
    run [failure err400{serverErrorHeaders=[("X-Origin","first")]}, failure err400{serverErrorHeaders=[("X-Origin","second")]}]
      >>= (`shouldBe` Left err400{serverErrorHeaders=[("X-Origin","first")]})
  it "keeps a more specific first error over a later not-found" $
    run [failure err400, failure err404] >>= (`shouldBe` Left err400)
  it "propagates a later fatal error instead of comparing its priority" $
    run [failure err400, \_ _ _ _ -> pure (FailFatal err404)] >>= (`shouldBe` Left err404)
  it "merges method errors when one route has no Allow header" $
    serverErrorHeaders (unionAllow err405 err405{serverErrorHeaders=[("Allow"," , GET, , GET, POST, ")]})
      `shouldBe` [("Allow","GET, POST")]
  it "decodes paths without a leading slash" $
    splitPathSegments "a%20b/c" `shouldBe` ["a b","c"]

  it "executes the shared host and Worker router contract scenarios" $ do
    names <- runRouterInternals request context
    names `shouldBe`
      [ "static-root-markers", "capture-choice", "capture-missing"
      , "capture-all-root-marker", "heterogeneous-choice", "path-splitting"
      , "allow-missing-and-empty-values", "failure-priority"
      , "failure-tie-preserves-first", "later-fatal-error"
      , "accept-check-order", "accept-check-short-circuit", "content-type-pairing"
      , "route-result-short-circuit", "delayed-map-preserves-failure"
      , "delayed-arguments-preserve-failed-server", "capture-hints-merge-without-duplicates"
      , "choice-success-skips-later-application", "choice-prefers-later-higher-priority"
      , "request-extraction"
      ]

  it "preserves all old and new values through every delayed composition" $
    runForwardingContracts request `shouldReturn` replicate 7 [11,12,13,14,15,1,60]

  it "checks each fatal and recoverable delayed boundary on the host" $
    runDelayedFailures request `shouldReturn`
      [ prefix <> stage | prefix <- ["recoverable-", "fatal-"], stage <- ["capture", "method", "auth", "accept", "content", "params", "headers", "body"] ]

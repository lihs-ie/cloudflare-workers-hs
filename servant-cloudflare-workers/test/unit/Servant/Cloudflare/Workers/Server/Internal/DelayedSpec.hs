module Servant.Cloudflare.Workers.Server.Internal.DelayedSpec (spec) where
import Test.Syd hiding (context)
import Data.IORef
import Control.Monad.IO.Class (liftIO)
import Cloudflare.Workers.HTTP (requestMethod, Method(GET))
import Servant.Cloudflare.Workers.Error (err400)
import Servant.Cloudflare.Workers.Server.Internal.Delayed
import Servant.Cloudflare.Workers.Server.Internal.DelayedIO (delayedFail, delayedFailFatal)
import Servant.Cloudflare.Workers.Server.Internal.RouteResult
import Support.HTTP.Fixtures (request)
import Support.Delayed.Trace
spec :: Spec
spec = do
  it "runs checks in dependency order" $ do
    ref <- newIORef []
    runDelayed (tracedDelayed ref Nothing) () request `shouldReturn` Route 42
    readIORef ref `shouldReturn` stages
  describe "short circuits at each failed check" $ mapM_ (\stage -> it stage $ do
    ref <- newIORef []
    runDelayed (tracedDelayed ref (Just stage)) () request `shouldReturn` FailFatal err400
    readIORef ref `shouldReturn` (takeWhile (/= stage) stages <> [stage])) stages
  it "preserves failures when mapping a delayed result" $
    runDelayed (fmap (+1) (emptyDelayed (Fail err400))) () request `shouldReturn` Fail err400
  it "maps successful delayed results" $
    runDelayed (fmap (+1) (emptyDelayed (Route (41::Int)))) () request `shouldReturn` Route 42
  it "passes captured values to the server" $
    runDelayed (addCapture (emptyDelayed (Route ((+1) :: Int -> Int))) (pure . (*2))) (20,()) request `shouldReturn` Route 41
  it "passes authentication values to the server" $
    runDelayed (addAuthCheck (emptyDelayed (Route ((+1) :: Int -> Int))) (pure 41)) () request `shouldReturn` Route 42
  it "passes parameter values to the server" $
    runDelayed (addParameterCheck (emptyDelayed (Route ((+1) :: Int -> Int))) (pure 41)) () request `shouldReturn` Route 42
  it "passes header values to the server" $
    runDelayed (addHeaderCheck (emptyDelayed (Route ((+1) :: Int -> Int))) (pure 41)) () request `shouldReturn` Route 42
  it "passes content-dependent body values to the server" $
    runDelayed (addBodyCheck (emptyDelayed (Route ((+1) :: Int -> Int))) (pure 20) (pure . (*2))) () request `shouldReturn` Route 41
  it "runs an added accept check and propagates its failure" $
    runDelayed (addAcceptCheck (emptyDelayed (Route (42::Int))) (delayedFail err400)) () request `shouldReturn` Fail err400
  it "runs an added method check and propagates its failure" $
    runDelayed (addMethodCheck (emptyDelayed (Route (42::Int))) (delayedFail err400)) () request `shouldReturn` Fail err400

  it "preserves parameter order when several checks are attached" $
    runDelayed
      (addParameterCheck (addParameterCheck (emptyDelayed (Route ((,) :: Int -> Int -> (Int,Int)))) (pure 11)) (pure 22))
      () request `shouldReturn` Route (11,22)
  it "threads each content type to its corresponding body decoder" $
    runDelayed
      (addBodyCheck
        (addBodyCheck (emptyDelayed (Route ((,) :: Int -> Int -> (Int,Int)))) (pure 10) (pure . (+1)))
        (pure 20) (pure . (+2)))
      () request `shouldReturn` Route (11,22)
  it "does not run a later method check when an earlier check fails" $ do
    calls <- newIORef (0 :: Int)
    let delayed = addMethodCheck
          (addMethodCheck (emptyDelayed (Route (42 :: Int))) (delayedFail err400))
          (liftIO (modifyIORef' calls (+1)))
    runDelayed delayed () request `shouldReturn` Fail err400
    readIORef calls `shouldReturn` 0
  it "runs accept checks in registration order" $ do
    calls <- newIORef ([] :: [Int])
    let delayed = addAcceptCheck
          (addAcceptCheck (emptyDelayed (Route (42 :: Int))) (liftIO (modifyIORef' calls (<> [1]))))
          (liftIO (modifyIORef' calls (<> [2])))
    runDelayed delayed () request `shouldReturn` Route 42
    readIORef calls `shouldReturn` [1,2]
  it "does not run a later accept check after fatal rejection" $ do
    calls <- newIORef (0 :: Int)
    let delayed = addAcceptCheck
          (addAcceptCheck (emptyDelayed (Route (42 :: Int))) (delayedFailFatal err400))
          (liftIO (modifyIORef' calls (+1)))
    runDelayed delayed () request `shouldReturn` FailFatal err400
    readIORef calls `shouldReturn` 0
  it "passes the current request to the delayed server" $
    runDelayed (passToServer (emptyDelayed (Route id)) requestMethod) () request `shouldReturn` Route GET
  it "does not extract a request value when the server already failed" $
    runDelayed (passToServer (emptyDelayed (FailFatal err400 :: RouteResult (Int -> Int)))
      (\_ -> error "request extraction must remain lazy on failure")) () request `shouldReturn` FailFatal err400

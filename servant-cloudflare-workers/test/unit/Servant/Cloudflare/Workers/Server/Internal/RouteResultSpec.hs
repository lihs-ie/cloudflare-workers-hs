module Servant.Cloudflare.Workers.Server.Internal.RouteResultSpec (spec) where

import Control.Monad.IO.Class (liftIO)
import Data.Functor ((<&>))
import Data.IORef
import Hedgehog (forAll, property, (===))
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
import Servant.Cloudflare.Workers.Error
import Servant.Cloudflare.Workers.Server.Internal.RouteResult
import Test.Syd hiding (context)
import Test.Syd.Hedgehog ()

spec :: Spec
spec = do
    it "preserves recoverable failures across bind" $
        (Fail err404 >>= (Route . (+ 1))) `shouldBe` (Fail err404 :: RouteResult Int)
    it "preserves fatal failures across bind" $
        (FailFatal err400 >>= (Route . (+ 1))) `shouldBe` (FailFatal err400 :: RouteResult Int)
    it "binds successful generated values" $ property $ do
        value <- forAll (Gen.int (Range.linear (-10000) 10000))
        (Route value >>= (Route . (+ 1))) === Route (value + 1)
    it "applies successful functions" $
        (Route (+ 1) <*> Route (41 :: Int)) `shouldBe` Route 42
    it "does not execute an IO continuation after either failure" $
        mapM_
            ( \failure -> do
                ref <- newIORef (0 :: Int)
                result <- runRouteResultT $ do
                    _ <- RouteResultT (pure failure)
                    liftIO (modifyIORef' ref (+ 1))
                    pure (42 :: Int)
                result `shouldBe` failure
                readIORef ref `shouldReturn` 0
            )
            [Fail err404, FailFatal err400]
    it "lifts IO and binds successful transformer values" $
        runRouteResultT (liftIO (pure (41 :: Int)) <&> (+ 1)) `shouldReturn` Route 42

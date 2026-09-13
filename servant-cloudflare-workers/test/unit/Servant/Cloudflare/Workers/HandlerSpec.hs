module Servant.Cloudflare.Workers.HandlerSpec (spec) where
import Test.Syd hiding (context)
import Control.Monad.Reader (ask, local, reader)
import Control.Monad.Except (throwError, catchError)
import Control.Monad.IO.Class (liftIO)
import Data.IORef
import Control.Applicative (liftA2)
import Servant.Cloudflare.Workers.Handler
import Servant.Cloudflare.Workers.Error
import Support.Handler.Runner
spec :: Spec
spec = do
  it "reads the supplied environment and scopes local changes" $ do
    result <- runHandler (10 :: Int) $ do
      original <- ask
      changed <- local (+1) ask
      restored <- ask
      pure (original, changed, restored)
    result `shouldBe` Right (10,11,10)
  it "short-circuits IO after a server error" $ do
    ref <- newIORef False
    result <- runHandler () (throwError err400 >> liftIO (writeIORef ref True))
    result `shouldBe` Left err400
    readIORef ref >>= (`shouldBe` False)
  it "can recover a server error within the handler" $ do
    result <- runHandler () (catchError (throwError err404) (pure . serverErrorStatusCode))
    result `shouldBe` Right 404
  it "provides the execution context without replacing the binding environment" $ do
    result <- runHandler (42 :: Int) (askExecutionContext >> ask)
    result `shouldBe` Right 42
  it "supports applicative composition and mapping over environment values" $ do
    result <- runHandler (10 :: Int) ((,) <$> ((+1) <$> ask) <*> reader (*2))
    result `shouldBe` Right (11,20)
  it "sequences applicative effects in order and retains the selected value" $ do
    ref <- newIORef ([] :: [Int])
    let action n = liftIO (modifyIORef' ref (++ [n])) >> pure n
    result <- runHandler () ((99 <$ action 1) <* action 2 *> action 3)
    result `shouldBe` Right 3
    readIORef ref >>= (`shouldBe` [1,2,3])
  it "uses liftA2 for independent handler values" $ do
    result <- runHandler (10 :: Int) (liftA2 (+) ask (pure 2))
    result `shouldBe` Right 12

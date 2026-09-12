module Servant.Cloudflare.Workers.ErrorMappingSpec (spec) where
import Test.Syd hiding (context)
import Control.Exception (IOException, ArithException(..), throwIO, try)
import System.IO.Error (ioeGetErrorString)
import Data.Text qualified as Text
import Control.Monad.Except (throwError)
import Control.Monad.IO.Class (liftIO)
import Servant.Cloudflare.Workers.Error
import Servant.Cloudflare.Workers.ErrorMapping
import Servant.Cloudflare.Workers.Handler (Handler)
import Support.Handler.Runner
type ServantHandler = Handler () Int
spec :: Spec
spec = do
  it "preserves successful results" $ do
    result <- runHandler () (mapExceptionsToServerError @IOException (const err500) (pure (17 :: Int)))
    result `shouldBe` Right 17
  it "preserves an explicit ServerError" $ do
    result <- runHandler () (mapExceptionsToServerError @IOException (const err500) (throwError err404 :: ServantHandler))
    result `shouldBe` Left err404
  it "maps the selected exception type" $ do
    result <- runHandler () (mapExceptionsToServerError @IOException (const err400) (liftIO (ioError (userError "invalid")) :: ServantHandler))
    result `shouldBe` Left err400
  it "does not swallow exceptions of a different type" $ do
    result <- try @ArithException $ runHandler () (mapExceptionsToServerError @IOException (const err500) (liftIO (throwIO DivideByZero) :: ServantHandler))
    result `shouldBe` Left DivideByZero
  it "passes exception details to the mapping function" $ do
    result <- runHandler () (mapExceptionsToServerError @IOException (\e -> withDetail (Text.pack (ioeGetErrorString e)) err400) (liftIO (ioError (userError "invalid input")) :: ServantHandler))
    result `shouldBe` Left (withDetail "invalid input" err400)

module Servant.Cloudflare.Workers.GenericSpec (spec) where
import Test.Syd hiding (context)
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.URL (parseURL)
import Control.Monad.Reader (ask)
import GHC.Generics (from, to)
import Support.Server.Requests (atPath)
import Data.Text (Text)
import Servant.Cloudflare.Workers.Generic
import Servant.Cloudflare.Workers.Server (Context(..))
import Support.Generic.Routes
import Support.HTTP.Fixtures
spec :: Spec
spec = do
  it "dispatches named route fields to their own handlers" $ do
    let routes = Routes {greeting = ask, farewell = pure "goodbye"} :: Routes (AsWorker Text)
    case (parseURL "https://example.test/greeting", parseURL "https://example.test/farewell") of
      (Just greetingURL, Just farewellURL) -> do
        first <- genericServeWithContext EmptyContext routes request{requestURLField=greetingURL} context "hello"
        second <- genericServeWithContext EmptyContext routes request{requestURLField=farewellURL} context "hello"
        responseStatus first `shouldBe` Status 200
        bodyBytes first `shouldBe` "hello"
        responseStatus second `shouldBe` Status 200
        bodyBytes second `shouldBe` "goodbye"
      _ -> expectationFailure "invalid fixed test URLs"

  it "reconstructs generic routes and preserves both selected handlers" $ do
    let original = Routes {greeting = ask, farewell = pure "goodbye"} :: Routes (AsWorker Text)
        restored = to (from original) :: Routes (AsWorker Text)
        selected = Routes {greeting = greeting restored, farewell = farewell restored}
    first <- genericServeWithContext EmptyContext selected (atPath "https://example.test/greeting") context "hello"
    second <- genericServeWithContext EmptyContext selected (atPath "https://example.test/farewell") context "hello"
    responseStatus first `shouldBe` Status 200
    bodyBytes first `shouldBe` "hello"
    responseStatus second `shouldBe` Status 200
    bodyBytes second `shouldBe` "goodbye"

module Realtime.Application (server) where
import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.HTTP (Request(..), Method(..), requestMethod, createResponse, Status(..), ResponseBody(..))
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.URL (parseURL)
import Data.Aeson (object, (.=))
import Control.Monad.IO.Class (liftIO)
import Data.Text (Text)
import Data.Text qualified as Text
import Realtime.API
import Servant.Cloudflare.Workers.Server (Server)
server :: DurableObjectNamespace -> Server API ()
server namespace = Routes
  { health = pure (object ["status" .= ("ok" :: Text)])
  , createRoom = liftIO $ do
      identifier <- doNewUniqueID namespace
      text <- doIDToString identifier
      pure (object ["identifier" .= text])
  , roomByIdentifier = \identifier remaining request _ -> do
      parsed <- doIDFromString namespace identifier
      case parsed of
        Left _ -> pure (createResponse (Status 400) (headersFromList []) (ResponseBodyBytes "Invalid room identifier"))
        Right value -> do
          stub <- doGet namespace value
          forward stub remaining request
  , room = \name remaining request _ ->
      if remaining == ["connect"] && requestMethod request /= GET
      then pure (createResponse (Status 405) (headersFromList [("Allow", "GET")]) (ResponseBodyBytes "GET required"))
      else do
        stub <- doGetByName namespace name
        forward stub remaining request
  }
  where
    forward stub remaining request = do
        url <- maybe (fail "Invalid internal room URL") pure (parseURL ("https://room.internal/" <> Text.intercalate "/" remaining))
        doFetch stub request{requestURLField = url}

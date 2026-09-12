module Support.Cloudflare.Workers.HTTP (recordingBodyReader, requestWithHeaders) where
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers
import Cloudflare.Workers.URL
import Cloudflare.Workers.Streaming (ReadableStreamReadError)
import Data.ByteString.Lazy qualified as LBS
import Data.IORef
import Data.Maybe (fromJust)
recordingBodyReader :: IO (IORef [Int], Int -> IO (Either ReadableStreamReadError LBS.ByteString))
recordingBodyReader = do
  limits <- newIORef []
  pure (limits, \limit -> modifyIORef' limits (++ [limit]) >> pure (Right "accepted"))
requestWithHeaders :: Headers -> Request
requestWithHeaders headers = Request GET (fromJust (parseURL "/sample")) Nothing headers Nothing Nothing

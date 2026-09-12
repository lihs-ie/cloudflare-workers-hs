module Support.Handler.Runner (runHandler) where
import Control.Monad.Except (runExceptT)
import Control.Monad.Reader (runReaderT)
import Servant.Cloudflare.Workers.Handler
import Servant.Cloudflare.Workers.Error (ServerError)
import Support.HTTP.Fixtures (context)
runHandler :: env -> Handler env a -> IO (Either ServerError a)
runHandler env action = runExceptT (runReaderT (runReaderT (unHandler action) env) context)

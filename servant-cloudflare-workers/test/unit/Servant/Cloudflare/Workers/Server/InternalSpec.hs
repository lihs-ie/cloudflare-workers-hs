module Servant.Cloudflare.Workers.Server.InternalSpec (spec) where
import Servant.Cloudflare.Workers.Server.Internal.StreamCases qualified as Stream
import Servant.Cloudflare.Workers.Server.Internal.RuntimeRoutingCases qualified as RuntimeRouting
import Test.Syd
import Servant.Cloudflare.Workers.Server.Internal.ParameterCases qualified as Parameters
import Servant.Cloudflare.Workers.Server.Internal.BodyCases qualified as Body
spec :: Spec
spec = do
  Parameters.spec
  Body.spec
  Stream.spec
  RuntimeRouting.spec

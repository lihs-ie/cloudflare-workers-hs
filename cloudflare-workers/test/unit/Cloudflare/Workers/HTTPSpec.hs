module Cloudflare.Workers.HTTPSpec (spec) where
import Cloudflare.Workers.HTTP.RequestCases qualified as Request
import Cloudflare.Workers.HTTP.ResponseCases qualified as Response
import Test.Syd
spec :: Spec
spec = do
  describe "request" Request.spec
  describe "response" Response.spec

module Support.Conformance.Generators (requestCaseGen) where
import Support.Conformance.Oracle (RequestCase (..))
import qualified Data.ByteString.Char8 as BS8
import Hedgehog (Gen)
import qualified Hedgehog.Gen as Gen
import qualified Hedgehog.Range as Range

-- | Independent dimensions exercise successful, malformed and unsupported
-- combinations. Shrinking retains a concrete request, with no precondition discard.
requestCaseGen :: Gen RequestCase
requestCaseGen = do
  method <- Gen.element ["GET", "POST", "PUT", "DELETE", "HEAD"]
  number <- Gen.int (Range.linear (-1000) 1000)
  target <- Gen.element ["/hello", "/plain", "/missing", "/capture/nope", "/capture/" <> BS8.pack (show number), "/query?value=" <> BS8.pack (show number), "/query?value=nope", "/header", "/echo"]
  accept <- Gen.element [[], [("Accept", "application/json")], [("Accept", "text/plain")], [("Accept", "*/*")], [("Accept", "image/png")]]
  contentType <- Gen.element [[], [("Content-Type", "application/json")], [("Content-Type", "text/plain")]]
  header <- Gen.element [[], [("X-Value", BS8.pack (show number))], [("X-Value", "invalid")]]
  body <- Gen.element ["", "\"hello\"", "null", "42", "invalid"]
  pure (RequestCase "generated" method target (accept ++ contentType ++ header) body)

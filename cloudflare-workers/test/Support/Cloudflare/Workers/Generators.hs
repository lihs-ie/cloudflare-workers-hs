module Support.Cloudflare.Workers.Generators (unicodeText, byteString, kvRestCount, r2RestCount, cacheTtl, ssecByteCount, uuidWord) where
import Data.Text (Text)
import Data.Word (Word64)
import Data.ByteString (ByteString)
import Data.ByteString qualified as BS
import Hedgehog (Gen)
import Hedgehog.Gen qualified as Gen
import Hedgehog.Range qualified as Range
unicodeText :: Gen Text
unicodeText = Gen.text (Range.linear 0 80) Gen.unicode
byteString :: Gen ByteString
byteString = BS.pack <$> Gen.list (Range.linear 0 80) (Gen.word8 Range.constantBounded)

kvRestCount, r2RestCount, cacheTtl, ssecByteCount :: Gen Int
kvRestCount = Gen.int (Range.linear 0 120)
r2RestCount = Gen.int (Range.linear 0 1020)
cacheTtl = Gen.int (Range.linear (-100) 200)
ssecByteCount = Gen.int (Range.linear 0 64)
uuidWord :: Gen Word64
uuidWord = Gen.word64 Range.constantBounded

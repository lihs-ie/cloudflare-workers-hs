-- | Development-only reference interpreter. Never imported by shipping libraries.
module Support.Conformance.Oracle
  ( ReferenceAPI, RequestCase (..), Observation (..), referenceVersion
  , evaluateReference, fixedCases, compatible, goldenDocument
  ) where

import Data.Aeson (Value, object, (.=))
import qualified Data.ByteString as BS
import qualified Data.ByteString.Char8 as BS8
import qualified Data.ByteString.Lazy as LBS
import qualified Data.CaseInsensitive as CI
import Data.SOP.BasicFunctors (I (I))
import Data.Text (Text)
import qualified Data.Text as Text
import Network.HTTP.Types (hContentType, statusCode)
import qualified Network.Wai as Wai
import qualified Network.Wai.Test as Wai
import Servant
import Servant.API.UVerb qualified as U

type ReferenceAPI =
       "hello" :> Get '[JSON] Text
  :<|> "capture" :> Capture "value" Int :> Get '[JSON] Int
  :<|> "query" :> QueryParam "value" Int :> Get '[JSON] (Maybe Int)
  :<|> "header" :> Header "X-Value" Int :> Get '[JSON] (Maybe Int)
  :<|> "echo" :> ReqBody '[JSON] Text :> Post '[JSON] Text
  :<|> "plain" :> Get '[PlainText] Text
  :<|> "union" :> Capture "outcome" Text :> ReqBody '[JSON] Text :> U.UVerb 'POST '[JSON, PlainText]
        '[ U.WithStatus 201 (Headers '[Header "Location" Text] Text)
         , U.WithStatus 200 Text
         , U.WithStatus 409 Text
         ]

data RequestCase = RequestCase
  { caseName :: Text
  , requestMethod :: BS.ByteString
  , requestTarget :: BS.ByteString
  , requestHeaders :: [(BS.ByteString, BS.ByteString)]
  , requestBody :: LBS.ByteString
  } deriving (Eq, Read, Show)

data Observation = Observation
  { responseStatus :: Int
  , responseContentType :: Maybe BS.ByteString
  , responseBody :: LBS.ByteString
  } deriving (Eq, Read, Show)

referenceVersion :: Text
referenceVersion = "servant-server-0.20.3.0"

referenceServer :: Server ReferenceAPI
referenceServer = pure "hello" :<|> pure :<|> pure :<|> pure :<|> pure :<|> pure "plain" :<|> unionHandler
  where
    unionHandler outcome payload = pure $ case outcome of
      "created" -> U.inject (I (U.WithStatus @201 (addHeader @"Location" ("/objects/new" :: Text) payload)))
      "done" -> U.inject (I (U.WithStatus @200 payload))
      _ -> U.inject (I (U.WithStatus @409 payload))

evaluateReference :: RequestCase -> IO Observation
evaluateReference c = do
  let request = (Wai.setPath Wai.defaultRequest (requestTarget c))
        { Wai.requestMethod = requestMethod c
        , Wai.requestHeaders = [(CI.mk key, value) | (key,value) <- requestHeaders c]
        }
  result <- Wai.runSession (Wai.srequest (Wai.SRequest request (requestBody c)))
    (serve (Proxy @ReferenceAPI) referenceServer)
  pure Observation
    { responseStatus = statusCode (Wai.simpleStatus result)
    , responseContentType = lookup hContentType (Wai.simpleHeaders result)
    , responseBody = Wai.simpleBody result
    }

-- | ADR-0006: error status remains compatible with servant-server, while
-- error Content-Type and body belong to the independently tested Workers contract.
-- Keep the existing informational/redirect boundary and exact successful bodies.
compatible :: Observation -> Observation -> Bool
compatible expected actual =
  responseStatus expected == responseStatus actual
    && (responseStatus expected >= 400
        || responseContentType expected == responseContentType actual)
    && (responseStatus expected < 200 || responseStatus expected >= 300
        || responseBody expected == responseBody actual)

fixedCases :: [RequestCase]
fixedCases =
  [ RequestCase ("method-" <> Text.pack (BS8.unpack method) <> "-" <> Text.pack (BS8.unpack target)) method target [] ""
  | target <- ["/hello", "/plain", "/missing", "/capture/12", "/echo"]
  , method <- ["GET", "POST", "PUT", "HEAD", "DELETE"]
  ] ++
  [ RequestCase ("accept-" <> Text.pack (show index)) "GET" target [("Accept", accept)] ""
  | (index, (target, accept)) <- zip [1 :: Int ..]
      [(target, accept) | target <- ["/hello", "/plain"], accept <- ["application/json", "text/plain", "*/*", "image/png", "application/json;q=0.5,text/plain;q=1"]]
  ] ++
  [ RequestCase "capture-negative" "GET" "/capture/-12" [] ""
  , RequestCase "capture-invalid" "GET" "/capture/nope" [] ""
  , RequestCase "capture-missing" "GET" "/capture" [] ""
  , RequestCase "query-valid" "GET" "/query?value=42" [] ""
  , RequestCase "query-invalid" "GET" "/query?value=nope" [] ""
  , RequestCase "query-absent" "GET" "/query" [] ""
  , RequestCase "header-valid" "GET" "/header" [("X-Value", "42")] ""
  , RequestCase "header-invalid" "GET" "/header" [("X-Value", "nope")] ""
  , RequestCase "header-absent" "GET" "/header" [] ""
  , RequestCase "echo-json" "POST" "/echo" [("Content-Type", "application/json")] "\"hello\""
  , RequestCase "echo-invalid-json" "POST" "/echo" [("Content-Type", "application/json")] "invalid"
  , RequestCase "echo-wrong-type" "POST" "/echo" [("Content-Type", "text/plain")] "hello"
  , RequestCase "echo-empty" "POST" "/echo" [("Content-Type", "application/json")] ""
  , RequestCase "echo-unacceptable" "POST" "/echo" [("Content-Type", "application/json"), ("Accept", "image/png")] "\"hello\""
  , RequestCase "echo-json-number" "POST" "/echo" [("Content-Type", "application/json")] "42"
  , RequestCase "uverb-created" "POST" "/union/created" [("Content-Type", "application/json")] "\"new-object\""
  , RequestCase "uverb-done-plaintext" "POST" "/union/done" [("Content-Type", "application/json"), ("Accept", "text/plain")] "\"four\""
  , RequestCase "uverb-conflict" "POST" "/union/conflict" [("Content-Type", "application/json")] "\"ignored\""
  , RequestCase "uverb-accept-before-body" "POST" "/union/created" [("Content-Type", "application/json"), ("Accept", "application/xml")] "not-json"
  ]

-- Byte arrays keep arbitrary request/response bytes lossless and deterministic.
goldenDocument :: IO Value
goldenDocument = do
  cases <- mapM render fixedCases
  pure $ object ["referenceVersion" .= referenceVersion, "cases" .= cases]
  where
    render c = do
      result <- evaluateReference c
      pure $ object
        [ "name" .= caseName c
        , "method" .= BS.unpack (requestMethod c)
        , "target" .= BS.unpack (requestTarget c)
        , "headers" .= [(BS.unpack key, BS.unpack value) | (key,value) <- requestHeaders c]
        , "body" .= LBS.unpack (requestBody c)
        , "status" .= responseStatus result
        , "contentType" .= fmap BS.unpack (responseContentType result)
        , "successBody" .= if responseStatus result >= 200 && responseStatus result < 300
            then Just (LBS.unpack (responseBody result)) else Nothing
        ]

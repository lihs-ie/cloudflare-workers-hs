module URLShortener.API (
    URLShortenerApi,
    ExhaustiveAPI,
    ShortenRequest (..),
    ShortenedURL (..),
    AdminStats (..),
)
where

import Cloudflare.Workers.Streaming (ReadableStream)
import Data.Aeson (FromJSON, ToJSON)
import Data.Text (Text)
import GHC.Generics (Generic)
import Servant.API (
    Capture,
    Description,
    EmptyAPI,
    Get,
    Header,
    Headers,
    JSON,
    NoContent,
    NoFraming,
    OctetStream,
    Post,
    QueryFlag,
    QueryParam,
    QueryParams,
    Raw,
    ReqBody,
    StdMethod (DELETE, GET, POST),
    Stream,
    Summary,
    UVerb,
    Verb,
    WithNamedContext,
    WithStatus,
    (:<|>),
    (:>),
 )

newtype ShortenRequest = ShortenRequest
    { shortenRequestTargetURL :: Text
    }
    deriving stock (Show, Eq, Generic)

instance ToJSON ShortenRequest

instance FromJSON ShortenRequest

data ShortenedURL = ShortenedURL
    { shortenedURLCode :: Text
    , shortenedURLTargetURL :: Text
    }
    deriving stock (Show, Eq, Generic)

instance ToJSON ShortenedURL

instance FromJSON ShortenedURL

newtype AdminStats = AdminStats
    { adminStatsTotalShortenedURLCount :: Int
    }
    deriving stock (Show, Eq, Generic)

instance ToJSON AdminStats

instance FromJSON AdminStats

type URLShortenerApi =
    "shorten" :> ReqBody '[JSON] ShortenRequest :> Post '[JSON] ShortenedURL
        :<|> "r" :> Capture "code" Text :> Get '[JSON] ShortenedURL

type ExhaustiveAPI =
    Summary "Exhaustive combinator recap"
        :> Description "Touches every HasWorkerServer instance built in ch-06-01...18"
        :> ( "r"
                :> Capture "code" Text
                :> QueryParam "utm" Text
                :> QueryParams "tag" Text
                :> QueryFlag "preview"
                :> Header "If-None-Match" Text
                :> Verb 'GET 200 '[JSON] (Headers '[Header "X-RateLimit-Remaining" Int] ShortenedURL)
           )
        :<|> "shorten"
            :> ReqBody '[JSON] ShortenRequest
            :> UVerb 'POST '[JSON] '[WithStatus 201 ShortenedURL, WithStatus 200 ShortenedURL]
        :<|> "stats"
            :> Capture "code" Text
            :> Stream 'GET 200 NoFraming OctetStream ReadableStream
        :<|> "assets" :> Raw
        :<|> WithNamedContext
                "admin-auth"
                '[]
                ("admin" :> "purge" :> Verb 'DELETE 204 '[JSON] NoContent)
        :<|> EmptyAPI

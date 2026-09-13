{-# LANGUAGE OverloadedRecordDot #-}

module Quickstart.Management (API, Routes (..), ManagementEnv (..), server, readURL) where

import Cloudflare.Workers.Binding.D1
import Control.Exception (try)
import Control.Monad (void, when)
import Control.Monad.Except (throwError)
import Control.Monad.IO.Class (liftIO)
import Control.Monad.Reader (ask)
import Data.Aeson (Value, object, (.=))
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import Data.Text qualified as T
import Data.Time
import GHC.Generics (Generic)
import Quickstart.Database
import Servant.API
import Servant.API.Generic ((:-))
import Servant.Cloudflare.Workers.Error
import Servant.Cloudflare.Workers.Handler (Handler)
import Servant.Cloudflare.Workers.Server (Server)
import Servant.Cloudflare.Workers.Server.Internal ()
import URLShortener.Domain

data ManagementEnv = ManagementEnv
    {database :: D1, admin :: Text, now :: IO UTCTime, newCode :: IO Text}

data Routes mode = Routes
    { createURL :: mode :- "urls" :> Header "Idempotency-Key" Text :> ReqBody '[JSON] CreateURL :> PostCreated '[JSON] ShortURL
    , listURLs :: mode :- "urls" :> QueryParam "after" Text :> QueryParam "limit" Int :> Get '[JSON] Value
    , getURL :: mode :- "urls" :> Capture "identifier" Text :> Get '[JSON] ShortURL
    , updateURL :: mode :- "urls" :> Capture "identifier" Text :> ReqBody '[JSON] EditURL :> Put '[JSON] ShortURL
    , deleteURL :: mode :- "urls" :> Capture "identifier" Text :> QueryParam "version" Int :> DeleteNoContent
    , getStats :: mode :- "stats" :> QueryParam "start" Day :> QueryParam "end" Day :> QueryParam "after" Text :> QueryParam "limit" Int :> Get '[JSON] Value
    }
    deriving stock (Generic)

type API = NamedRoutes Routes

server :: Server API ManagementEnv
server =
    Routes
        { createURL = handleCreateURL
        , listURLs = handleListURLs
        , getURL = handleGetURL
        , updateURL = handleEditURL
        , deleteURL = handleDeleteURL
        , getStats = handleStats
        }

bad :: Text -> Handler env a
bad = throwError . (`withDetail` err400)
conflict :: Text -> Handler env a
conflict msg = throwError (ServerError 409 "Conflict" [] (Just msg))

handleCreateURL :: Maybe Text -> CreateURL -> Handler ManagementEnv ShortURL
handleCreateURL keyMaybe input = do
    env <- ask
    clock <- liftIO env.now
    key <- maybe (bad "Idempotency-Key is required") pure keyMaybe
    when (T.null key || T.length key > 256) (bad "Idempotency-Key must contain 1 to 256 characters")
    let payload = jsonText input
    prior <- liftIO $ first env.database "SELECT request_json,response_body FROM admin_idempotency WHERE admin=? AND key=? AND expires_at>?" [D1Text env.admin, D1Text key, timeValue clock]
    case prior of
        Just row -> replay payload row
        Nothing -> do
            _ <- either bad pure (validateCreateURL clock input)
            createAttempt env clock key payload input 8
  where
    replay payload row = do
        previous <- liftIO (textColumn "request_json" row)
        when (previous /= payload) (conflict "Idempotency-Key was used with a different request")
        liftIO (textColumn "response_body" row >>= decodeText)
    createAttempt env clock key payload request remaining = do
        when (remaining == (0 :: Int)) (throwError err500)
        code <- liftIO env.newCode
        let CreateURL target expiry = request
            response = ShortURL code target clock expiry Nothing 1
            body = jsonText response
            statements =
                [ ("DELETE FROM admin_idempotency WHERE admin=? AND key=? AND expires_at<=?", [D1Text env.admin, D1Text key, timeValue clock])
                , ("INSERT INTO admin_idempotency(admin,key,request_json,response_status,response_body,created_at,expires_at) VALUES(?,?,?,201,?,?,?) ON CONFLICT(admin,key) DO NOTHING", [D1Text env.admin, D1Text key, D1Text payload, D1Text body, timeValue clock, timeValue (idempotencyExpiresAt clock)])
                , ("INSERT INTO urls(identifier,destination,created_at,expires_at,deleted_at,version) SELECT ?,?,?,?,NULL,1 WHERE EXISTS(SELECT 1 FROM admin_idempotency WHERE admin=? AND key=? AND response_body=?)", [D1Text code, D1Text target, timeValue clock, optionalTimeValue expiry, D1Text env.admin, D1Text key, D1Text body])
                ]
        outcome <- liftIO (try (batch env.database statements))
        case outcome of
            Left (D1ConstraintViolation detail) | "urls.identifier" `T.isInfixOf` detail -> createAttempt env clock key payload request (remaining - 1)
            Left (_ :: D1ExecutionError) -> throwError err500
            Right _ -> do
                stored <- liftIO $ first env.database "SELECT request_json,response_body FROM admin_idempotency WHERE admin=? AND key=?" [D1Text env.admin, D1Text key]
                maybe (throwError err500) (replay payload) stored

readURL :: D1 -> Text -> IO (Maybe ShortURL)
readURL db code = first db "SELECT * FROM urls WHERE identifier=?" [D1Text code] >>= traverse rowURL

rowURL :: Row -> IO ShortURL
rowURL row = do
    code <- textColumn "identifier" row
    target <- textColumn "destination" row
    created <- textColumn "created_at" row >>= parseTimestamp
    expiry <- optionalTimestamp "expires_at"
    deleted <- optionalTimestamp "deleted_at"
    revision <- fromInteger <$> integerColumn "version" row
    pure (ShortURL code target created expiry deleted revision)
  where
    optionalTimestamp key = case lookup key row of
        Just D1Null -> pure Nothing
        _ -> Just <$> (textColumn key row >>= parseTimestamp)
    parseTimestamp = parseTimeM True defaultTimeLocale "%Y-%m-%dT%H:%M:%S%QZ" . T.unpack

handleGetURL :: Text -> Handler ManagementEnv ShortURL
handleGetURL code = do
    env <- ask
    liftIO (readURL env.database code) >>= maybe (throwError err404) pure

pageLimit :: Maybe Int -> Handler env Int
pageLimit proposed = do
    let size = fromMaybe 100 proposed
    when (size < 1 || size > 100) (bad "limit must be between 1 and 100")
    pure size

handleListURLs :: Maybe Text -> Maybe Int -> Handler ManagementEnv Value
handleListURLs after proposed = do
    env <- ask
    size <- pageLimit proposed
    rows <- liftIO $ query env.database "SELECT * FROM urls WHERE identifier>? ORDER BY identifier LIMIT ?" [D1Text (fromMaybe "" after), D1Integer (toInteger (size + 1))]
    values <- liftIO $ traverse rowURL (take size rows)
    let next =
            if length rows > size
                then case reverse values of
                    ShortURL code _ _ _ _ _ : _ -> Just code
                    [] -> Nothing
                else Nothing
    pure (object ["items" .= values, "next" .= next])

handleEditURL :: Text -> EditURL -> Handler ManagementEnv ShortURL
handleEditURL code input@(EditURL target expiry revision) = do
    env <- ask
    clock <- liftIO env.now
    _ <- either bad pure (validateEditURL clock input)
    rows <- liftIO $ query env.database "UPDATE urls SET destination=?,expires_at=?,version=version+1 WHERE identifier=? AND version=? AND deleted_at IS NULL RETURNING *" [D1Text target, optionalTimeValue expiry, D1Text code, D1Integer (toInteger revision)]
    case rows of
        [row] -> liftIO (rowURL row)
        [] -> void (handleGetURL code) >> conflict "URL version changed or URL was deleted; read the current URL before retrying"
        _ -> throwError err500

handleDeleteURL :: Text -> Maybe Int -> Handler ManagementEnv NoContent
handleDeleteURL code revisionMaybe = do
    env <- ask
    revision <- maybe (bad "version is required") pure revisionMaybe
    when (revision < 1) (bad "version must be positive")
    clock <- liftIO env.now
    result <- liftIO $ execute env.database "UPDATE urls SET deleted_at=?,version=version+1 WHERE identifier=? AND version=? AND deleted_at IS NULL" [timeValue clock, D1Text code, D1Integer (toInteger revision)]
    requireChanged code result
    pure NoContent

requireChanged :: Text -> D1RunResult -> Handler ManagementEnv ()
requireChanged code result = when (d1MetaChanges (d1RunResultMeta result) /= Just 1) $ do
    void (handleGetURL code)
    conflict "URL version changed or URL was deleted; read the current URL before retrying"

handleStats :: Maybe Day -> Maybe Day -> Maybe Text -> Maybe Int -> Handler ManagementEnv Value
handleStats startMaybe endMaybe after proposed = do
    env <- ask
    start <- maybe (bad "start is required") pure startMaybe
    end <- maybe (bad "end is required") pure endMaybe
    _ <- either bad pure (mkDateRange start end)
    size <- pageLimit proposed
    rows <- liftIO $ query env.database "SELECT url,day,count FROM daily_clicks WHERE day>=? AND day<=? AND (url || '/' || day)>? ORDER BY url,day LIMIT ?" [D1Text (T.pack (show start)), D1Text (T.pack (show end)), D1Text (fromMaybe "" after), D1Integer (toInteger (size + 1))]
    entries <-
        liftIO $
            traverse
                ( \row -> do
                    code <- textColumn "url" row
                    day <- textColumn "day" row
                    count <- integerColumn "count" row
                    pure (object ["url" .= code, "day" .= day, "count" .= count], code <> "/" <> day)
                )
                (take size rows)
    let next =
            if length rows > size
                then case reverse entries of
                    (_, cursor) : _ -> Just cursor
                    [] -> Nothing
                else Nothing
    pure (object ["items" .= map fst entries, "next" .= next])

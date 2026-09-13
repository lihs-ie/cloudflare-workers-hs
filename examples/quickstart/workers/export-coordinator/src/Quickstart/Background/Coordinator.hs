{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE OverloadedStrings #-}

module Quickstart.Background.Coordinator (coordinatorFetch, coordinatorAlarm, withLease, Lease (..), Command (..), transition, leaseDurationMillis) where

import Cloudflare.Workers.Binding.DurableObject
import Cloudflare.Workers.HTTP
import Cloudflare.Workers.Headers (headersFromList)
import Cloudflare.Workers.Streaming (readableStreamToLazyByteString)
import Cloudflare.Workers.URL (parseURL)
import Control.Exception (bracket, throwIO)
import Data.Aeson
import Data.Aeson.Types (parseMaybe)
import Data.ByteString.Lazy qualified as Lazy
import Data.List (find)
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Time (UTCTime)
import Data.Time.Clock.POSIX (utcTimeToPOSIXSeconds)
import GHC.Generics (Generic)

data Lease = Lease {export :: Text, token :: Text, expiresAt :: Integer}
    deriving (Eq, Show, Generic)
instance ToJSON Lease
instance FromJSON Lease

data Command = Acquire Text Text | Renew Text Text | Release Text Text deriving (Eq, Show)

leaseDurationMillis :: Integer
leaseDurationMillis = 300000

-- All operations run inside the bridge's blockConcurrencyWhile. Tokens fence
-- stale releases and renewals; downstream publication must check its own token.
transition :: Integer -> Command -> [Lease] -> (Int, Maybe Lease, [Lease])
transition now command stored = case command of
    Acquire identifier freshToken
        | any ((== identifier) . export) active || length active >= 2 -> (409, Nothing, active)
        | otherwise ->
            let lease = Lease identifier freshToken (now + leaseDurationMillis)
             in (200, Just lease, lease : active)
    Renew identifier expected -> case matching identifier expected of
        Nothing -> (409, Nothing, active)
        Just lease ->
            let updated = lease{expiresAt = now + leaseDurationMillis}
             in (200, Just updated, updated : filter ((/= identifier) . export) active)
    Release identifier expected -> case matching identifier expected of
        Nothing -> (409, Nothing, active)
        Just _ -> (204, Nothing, filter ((/= identifier) . export) active)
  where
    active = filter ((> now) . expiresAt) stored
    matching identifier expected = find (\lease -> export lease == identifier && token lease == expected) active

loadLeases :: DurableObjectStorage -> IO [Lease]
loadLeases storage = do
    bytes <- doStorageGet storage "leases"
    case bytes of
        Nothing -> pure []
        Just value -> either (throwIO . userError . ("Invalid coordinator state: " <>)) pure (eitherDecodeStrict value)

saveLeases :: DurableObjectStorage -> [Lease] -> IO ()
saveLeases storage leases = do
    -- Arm first: interruption after scheduling is harmless, whereas persisting
    -- an active lease without an alarm would strand capacity until another call.
    case leases of
        [] -> pure ()
        _ -> doStorageSetAlarm storage (minimum (map expiresAt leases))
    doStoragePut storage "leases" (Lazy.toStrict (encode leases))
    case leases of
        [] -> doStorageDeleteAlarm storage
        _ -> pure ()

coordinatorAlarm :: DurableObjectStorage -> IO UTCTime -> IO ()
coordinatorAlarm storage clock = do
    now <- millis <$> clock
    leases <- loadLeases storage
    saveLeases storage (filter ((> now) . expiresAt) leases)

coordinatorFetch :: Request -> DurableObjectStorage -> IO UTCTime -> IO Text -> IO Response
coordinatorFetch request storage clock freshIdentifier
    | requestMethod request /= POST = pure (reply 405 (object ["error" .= ("method_not_allowed" :: Text)]))
    | otherwise = case requestBodyReader request of
        Nothing -> pure invalid
        Just reader -> do
            bytes <- reader 4096
            case bytes of
                Left _ -> pure invalid
                Right body -> case eitherDecode body >>= parseCommand (requestPath request) of
                    Left _ -> pure invalid
                    Right construct -> do
                        fresh <- freshIdentifier
                        now <- millis <$> clock
                        leases <- loadLeases storage
                        let (status, result, updated) = transition now (construct fresh) leases
                        saveLeases storage updated
                        pure $
                            if status == 204
                                then createResponse (Status 204) (headersFromList []) (ResponseBodyBytes mempty)
                                else reply status (maybe (object ["error" .= ("lease_unavailable" :: Text)]) toJSON result)
  where
    invalid = reply 400 (object ["error" .= ("invalid_coordinator_request" :: Text)])

parseCommand :: Text -> Value -> Either String (Text -> Command)
parseCommand path value =
    maybe (Left "invalid command") Right $
        parseMaybe
            ( withObject "command" $ \o -> do
                identifier <- o .: "export"
                if Text.null identifier || Text.length identifier > 256
                    then fail "invalid export"
                    else case path of
                        "/acquire" -> pure (Acquire identifier)
                        "/release" -> do expected <- o .: "token"; pure (const (Release identifier expected))
                        "/renew" -> do expected <- o .: "token"; pure (const (Renew identifier expected))
                        _ -> fail "unknown operation"
            )
            value

millis :: UTCTime -> Integer
millis = floor . (* 1000) . utcTimeToPOSIXSeconds

reply :: Int -> Value -> Response
reply status value =
    createResponse
        (Status status)
        (headersFromList [("content-type", "application/json"), ("cache-control", "no-store")])
        (ResponseBodyLazyBytes (encode value))

{- | The action renews between bounded work units. A failed acquisition/renewal
throws so the Queue consumer retries rather than publishing without a lease.
-}
withLease :: DurableObjectNamespace -> Text -> (IO () -> IO a) -> IO a
withLease namespace identifier action = do
    stub <- doGetByName namespace "csv-exports"
    let call path payload = do
            url <- maybe (throwIO (userError "invalid coordinator URL")) pure (parseURL path)
            doFetch
                stub
                Request
                    { requestMethodField = POST
                    , requestURLField = url
                    , requestBodyField = Nothing
                    , requestHeaders = headersFromList [("content-type", "application/json")]
                    , requestBodyReaderField = Just (\_ -> pure (Right (encode payload)))
                    , requestDataCenterField = Nothing
                    }
        acquire = do
            response <- call "/acquire" (object ["export" .= identifier])
            requireStatus 200 response
            bytes <- case responseBody response of
                ResponseBodyBytes value -> pure (Lazy.fromStrict value)
                ResponseBodyLazyBytes value -> pure value
                ResponseBodyStream value -> readableStreamToLazyByteString 4096 value >>= either (const (throwIO (userError "invalid lease response"))) pure
                ResponseBodyPassthrough _ -> throwIO (userError "unsupported lease response")
                ResponseBodyWebSocket _ -> throwIO (userError "unsupported lease response")
            -- doFetch currently returns buffered bytes, so the existing stream
            -- bound alone does not constrain ordinary lease responses.
            if Lazy.length bytes > 4096
                then throwIO (userError "invalid lease response")
                else either (throwIO . userError) pure (eitherDecode bytes)
        payload lease = object ["export" .= identifier, "token" .= token lease]
        release lease = do
            response <- call "/release" (payload lease)
            -- A lost/expired lease has already released capacity. Never release
            -- a replacement lease with an obsolete token.
            if statusCode (responseStatus response) `elem` [204, 409]
                then pure ()
                else requireStatus 204 response
        renew lease = call "/renew" (payload lease) >>= requireStatus 200
    bracket acquire release (action . renew)
  where
    requireStatus expected response
        | statusCode (responseStatus response) == expected = pure ()
        | otherwise = throwIO (userError ("coordinator rejected operation: " <> show (statusCode (responseStatus response))))

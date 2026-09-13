{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE TypeApplications #-}

module Support.Runtime.AccessVerification (accessVerificationProbe) where

import Control.Exception (SomeException, displayException, fromException, throwIO, try)
import Data.Aeson qualified as Aeson
import Data.Aeson.Types (parseEither, (.:), (.:?), (.!=))
import Data.ByteString.Lazy qualified as LBS
import Data.Text (Text)
import Data.Text qualified as Text
import Data.Text.Encoding qualified as Encoding
import ExampleSupport.Interop (jsValToText, textToJSVal)
import GHC.Wasm.Prim (JSVal)
import Servant.Cloudflare.Workers.Access
import Servant.Cloudflare.Workers.Access.SubtleCrypto
  ( JWK (..)
  , SubtleCryptoError (..)
  , subtleImportKey
  , subtleVerify
  )

-- | Exercise only consumer-visible Access and WebCrypto contracts.
accessVerificationProbe :: JSVal -> JSVal -> IO JSVal
accessVerificationProbe inputValue _nativeKey = do
  input <- jsValToText inputValue
  outcome <- try @SomeException $ do
    value <- either fail pure (Aeson.eitherDecodeStrict (Encoding.encodeUtf8 input))
    (mode, rawToken, cacheTtl, jwksURL) <- either fail pure $ parseEither
      (Aeson.withObject "Access probe" $ \object -> (,,,)
        <$> object .: "mode"
        <*> (object .:? "token" .!= "")
        <*> (object .:? "cacheTtl" .!= 0)
        <*> (object .:? "jwksURL" .!= accessConfigJWKSURL baseConfig)) value
    let assertion = AccessJWT rawToken
        token = unAccessJWT assertion
        config = baseConfig{accessConfigJWKSURL = jwksURL}
        options = defaultAccessVerifierOptions
          { accessVerifierOptionsJWKSCacheTtlSeconds = cacheTtl
          }
    case mode :: Text of
      "value-diagnostics" -> pure valueDiagnostics
      "typed-error-diagnostics" -> Aeson.toJSON <$> mapM exceptionDiagnostic
        [ AccessErrorInvalidSignature
        , AccessErrorExpored
        , AccessErrorAudienceMismach
        , AccessErrorMalformed "synthetic diagnostic"
        ]
      "service" -> either errorJSON serviceJSON
        <$> verifyAccessServiceJWTWithOptions options config token
      "user" -> either errorJSON userJSON
        <$> verifyAccessJWTWithOptions options config token
      "user-bottom-config" -> either errorJSON userJSON
        <$> verifyAccessJWTWithOptions options
          config{accessConfigTeamDomain = error "sensitive fixture marker"}
          token
      "crypto-public-verify" -> do
        jwk <- either fail pure $ parseEither
          (Aeson.withObject "JWK probe" (.: "jwk")) value
        key <- subtleImportKey "runtime-probe" jwk
        verified <- subtleVerify key "signature" "message"
        pure (Aeson.object ["ok" Aeson..= True, "verified" Aeson..= verified])
      "crypto-import" -> do
        jwk <- either fail pure $ parseEither
          (Aeson.withObject "JWK probe" (.: "jwk")) value
        _ <- subtleImportKey "runtime-probe" jwk
        pure (Aeson.object ["ok" Aeson..= True])
      "ping" -> pure (Aeson.object ["ok" Aeson..= True])
      _ -> fail "Unknown Access probe mode"
  textToJSVal $ Encoding.decodeUtf8 $ LBS.toStrict $ Aeson.encode $ case outcome of
    Left failure -> Aeson.object
      [ "ok" Aeson..= False
      , "message" Aeson..= displayException failure
      ]
    Right result -> result
  where
    exceptionDiagnostic original = do
      caught <- try @SomeException (throwIO original :: IO ())
      case caught of
        Left exception -> pure (Aeson.object
          [ "sameError" Aeson..= (fromException exception == Just original)
          , "diagnostic" Aeson..= displayException exception
          ])
        Right () -> fail "Expected the synthetic Access exception"
    baseConfig = AccessConfig
      "runtime-audience"
      "runtime-team"
      "https://runtime-team.cloudflareaccess.com/cdn-cgi/access/certs"
    errorJSON failure = Aeson.object
      ["ok" Aeson..= False, "message" Aeson..= Text.pack (show failure)]
    userJSON claims = Aeson.object
      [ "ok" Aeson..= True
      , "identity" Aeson..= accessClaimsEmail claims
      , "subject" Aeson..= accessClaimsSubject claims
      , "audience" Aeson..= accessClaimsAudience claims
      , "issuer" Aeson..= accessClaimsIssuer claims
      , "expiresAt" Aeson..= accessClaimsExpiresAt claims
      ]
    serviceJSON claims = Aeson.object
      [ "ok" Aeson..= True
      , "identity" Aeson..= accessServiceClaimsIdentifier claims
      , "audience" Aeson..= accessServiceClaimsAudience claims
      , "issuer" Aeson..= accessServiceClaimsIssuer claims
      , "expiresAt" Aeson..= accessServiceClaimsExpiresAt claims
      ]

valueDiagnostics :: Aeson.Value
valueDiagnostics = Aeson.object
  [ "snapshots" Aeson..=
      [ snapshot "assertion" (AccessJWT "synthetic-a") [AccessJWT "synthetic-b"]
      , snapshot "user" user
          [ user{accessClaimsEmail = "other"}
          , user{accessClaimsSubject = "other"}
          , user{accessClaimsAudience = []}
          , user{accessClaimsIssuer = "other"}
          , user{accessClaimsExpiresAt = 2}
          ]
      , snapshot "service" service
          [ service{accessServiceClaimsIdentifier = "other"}
          , service{accessServiceClaimsAudience = []}
          , service{accessServiceClaimsIssuer = "other"}
          , service{accessServiceClaimsExpiresAt = 2}
          ]
      , snapshot "config" config
          [ config{accessConfigAudience = "other"}
          , config{accessConfigTeamDomain = "other"}
          , config{accessConfigJWKSURL = "other"}
          ]
      , snapshot "policy" policy
          [ policy{accessVerifierOptionsClockSkewSeconds = 1}
          , policy{accessVerifierOptionsJWKSCacheTtlSeconds = 1}
          , policy{accessVerifierOptionsExpectedIssuer = Just "other"}
          ]
      , snapshot "access-error" (AccessErrorMalformed "synthetic-a")
          [AccessErrorMalformed "synthetic-b", AccessErrorInvalidSignature]
      , snapshot "crypto-error" (SubtleCryptoError "synthetic-a")
          [SubtleCryptoError "synthetic-b"]
      , snapshot "key" key [key{jwkKid = "other"}, key{jwkValue = Aeson.Null}]
      ]
  , "jwkRequiresValue" Aeson..= ((Aeson.omittedField :: Maybe JWK) == Nothing)
  ]
  where
    user = AccessClaims "synthetic@example.test" "subject" ["audience"] "issuer" 1
    service = AccessServiceClaims "synthetic.access" ["audience"] "issuer" 1
    config = AccessConfig "audience" "team" "https://example.test/certs"
    policy = defaultAccessVerifierOptions
    key = JWK "synthetic" (Aeson.object ["kid" Aeson..= ("synthetic" :: Text)])

snapshot :: (Eq value, Show value) => Text -> value -> [value] -> Aeson.Value
snapshot name original replacements = Aeson.object
  [ "name" Aeson..= name
  , "unchanged" Aeson..= (original == original)
  , "changesDetected" Aeson..= map (/= original) replacements
  , "single" Aeson..= show original
  , "batch" Aeson..= show [original, original]
  ]

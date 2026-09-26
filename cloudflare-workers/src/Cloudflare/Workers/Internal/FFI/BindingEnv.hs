module Cloudflare.Workers.Internal.FFI.BindingEnv (
    FromBindingJSVal (..),
    BuildBindingEnv (..),
    BuildDOSEnv (..),
) where

import Cloudflare.Workers.Binding.Assets (Assets (Assets))
import Cloudflare.Workers.Binding.D1 (D1 (D1))
import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace (DurableObjectNamespace), DurableObjectStorage (DurableObjectStorage))
import Cloudflare.Workers.Binding.Images (Images (Images))
import Cloudflare.Workers.Binding.KV (KV (KV))
import Cloudflare.Workers.Binding.Queue (QueueProducer (QueueProducer))
import Cloudflare.Workers.Binding.R2 (R2Bucket (R2Bucket))
import Cloudflare.Workers.Binding.Secret (Secret (Secret))
import Cloudflare.Workers.Binding.ServiceBinding (ServiceBinding (ServiceBinding))
import Cloudflare.Workers.Binding.Var (Var (Var))
import Cloudflare.Workers.Binding.Workflow (Workflow (Workflow))
import Cloudflare.Workers.Env (BindingMissingError (BindingMissingError))
import Cloudflare.Workers.Internal.FFI.Text (jsValToText)
import Cloudflare.Workers.Internal.WorkersAI (WorkersAI (WorkersAI))
import Control.Exception (throwIO)
import Data.Dynamic (Dynamic, Typeable, toDyn)
import Data.Kind (Type)
import Data.Map.Strict (Map)
import Data.Map.Strict qualified as Map
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.TypeLits (KnownSymbol, Symbol, symbolVal)
import GHC.Wasm.Prim (JSVal)

class FromBindingJSVal a where
    fromBindingJSVal :: JSVal -> IO a
    bindingAbsent :: Maybe a
    bindingAbsent = Nothing

instance FromBindingJSVal Var where
    fromBindingJSVal = fmap Var . requiredStringBinding

instance FromBindingJSVal Secret where
    fromBindingJSVal = fmap Secret . requiredStringBinding

instance FromBindingJSVal (Workflow params) where
    fromBindingJSVal = pure . Workflow

instance FromBindingJSVal Assets where
    fromBindingJSVal = pure . Assets

instance FromBindingJSVal KV where
    fromBindingJSVal = pure . KV

instance FromBindingJSVal D1 where
    fromBindingJSVal = pure . D1

instance FromBindingJSVal R2Bucket where
    fromBindingJSVal = pure . R2Bucket

instance FromBindingJSVal DurableObjectNamespace where
    fromBindingJSVal = pure . DurableObjectNamespace

instance FromBindingJSVal DurableObjectStorage where
    fromBindingJSVal = pure . DurableObjectStorage

instance FromBindingJSVal QueueProducer where
    fromBindingJSVal = pure . QueueProducer

instance FromBindingJSVal ServiceBinding where
    fromBindingJSVal = pure . ServiceBinding

instance FromBindingJSVal Images where
    fromBindingJSVal = pure . Images

instance FromBindingJSVal WorkersAI where
    fromBindingJSVal = pure . WorkersAI

instance FromBindingJSVal (Maybe Var) where
    fromBindingJSVal rawJSValue = do
        isNullish <- jsIsNullish rawJSValue
        if isNullish
            then pure Nothing
            else Just . Var <$> requiredStringBinding rawJSValue

    bindingAbsent = Just Nothing

instance FromBindingJSVal (Maybe Secret) where
    fromBindingJSVal rawJSValue = do
        isNullish <- jsIsNullish rawJSValue
        if isNullish
            then pure Nothing
            else Just . Secret <$> requiredStringBinding rawJSValue

    bindingAbsent = Just Nothing

-- Reject malformed configuration without coercing (or logging) secret values.
requiredStringBinding :: JSVal -> IO Text
requiredStringBinding value = do
    isString <- jsIsString value
    if isString then jsValToText value else throwIO (userError "Expected a string configuration binding")

foreign import javascript unsafe "typeof $1 === 'string'"
    jsIsString :: JSVal -> IO Bool

foreign import javascript unsafe "$1 === undefined || $1 === null"
    jsIsNullish :: JSVal -> IO Bool

class BuildBindingEnv (bindings :: [(Symbol, Type)]) where
    buildBindingEnv :: Proxy bindings -> Map Text JSVal -> IO (Map Text Dynamic)

instance BuildBindingEnv '[] where
    buildBindingEnv _proxy _rawBindings = pure Map.empty

instance
    (KnownSymbol sym, Typeable ty, FromBindingJSVal ty, BuildBindingEnv rest) =>
    BuildBindingEnv ('(sym, ty) ': rest)
    where
    buildBindingEnv _proxy rawBindings = do
        restBindings <- buildBindingEnv (Proxy @rest) rawBindings
        case Map.lookup bindingName rawBindings of
            Nothing -> case bindingAbsent :: Maybe ty of
                Nothing -> throwIO (BindingMissingError bindingName)
                Just absentValue -> pure (Map.insert bindingName (toDyn absentValue) restBindings)
            Just rawBindingJSVal -> do
                typedBindingValue <- fromBindingJSVal rawBindingJSVal :: IO ty
                pure (Map.insert bindingName (toDyn typedBindingValue) restBindings)
      where
        bindingName :: Text
        bindingName = Text.pack (symbolVal (Proxy @sym))

class BuildDOSEnv (dos :: [Symbol]) where
    buildDOSEnv :: Proxy dos -> Map Text JSVal -> IO (Map Text DurableObjectNamespace)

instance BuildDOSEnv '[] where
    buildDOSEnv _proxy _rawBindings = pure Map.empty

instance (KnownSymbol symbol, BuildDOSEnv rest) => BuildDOSEnv (symbol ': rest) where
    buildDOSEnv _proxy rawBindings = do
        restDOS <- buildDOSEnv (Proxy @rest) rawBindings
        case Map.lookup dosName rawBindings of
            Nothing -> throwIO (BindingMissingError dosName)
            Just rawDOSJSVal -> do
                namespace <- fromBindingJSVal rawDOSJSVal :: IO DurableObjectNamespace
                pure (Map.insert dosName namespace restDOS)
      where
        dosName :: Text
        dosName = Text.pack (symbolVal (Proxy @symbol))

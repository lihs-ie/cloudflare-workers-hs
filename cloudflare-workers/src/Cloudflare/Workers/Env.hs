module Cloudflare.Workers.Env (
    Bindings,
    BindingEnv (..),
    BindingType,
    getBinding,
    BindingMissingError (..),
    getDurableObjectNamespace,
) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectNamespace)
import Control.Exception (Exception)
import Data.Dynamic (Dynamic, Typeable, fromDynamic)
import Data.Kind (Constraint, Type)
import Data.Map.Strict (Map)
import Data.Map.Strict qualified as Map
import Data.Proxy (Proxy)
import Data.Text (Text)
import Data.Text qualified as Text
import GHC.TypeLits (KnownSymbol, Symbol, symbolVal)

type Bindings = [(Symbol, Type)]

data BindingEnv (kvs :: [Symbol]) (dos :: [Symbol]) (bindings :: Bindings)
    = BindingEnv (Map Text Dynamic) (Map Text DurableObjectNamespace)

type family BindingType (symbol :: Symbol) (bindings :: Bindings) :: Type where
    BindingType symbol ('(symbol, ty) ': _rest) = ty
    BindingType symbol (_Other ': rest) = BindingType symbol rest

getBinding ::
    forall symbol kvs dos bindings.
    (KnownSymbol symbol, Typeable (BindingType symbol bindings)) =>
    Proxy symbol ->
    BindingEnv kvs dos bindings ->
    BindingType symbol bindings
getBinding proxy (BindingEnv bindings _durableObjectNamespace) =
    case Map.lookup name bindings of
        Nothing -> error ("getBinding: no binding registered under " <> show name)
        Just dynamicValue -> case fromDynamic dynamicValue of
            Nothing -> error ("getBinding: binding " <> show name <> " has an unexpected runtime type")
            Just value -> value
  where
    name :: Text
    name = Text.pack (symbolVal proxy)

newtype BindingMissingError = BindingMissingError Text
    deriving stock (Show, Eq)

instance Exception BindingMissingError

type family RequireDurableObjectNamespace (symbol :: Symbol) (dos :: [Symbol]) :: Constraint where
    RequireDurableObjectNamespace symbol (symbol ': rest) = ()
    RequireDurableObjectNamespace symbol (_other ': rest) = RequireDurableObjectNamespace symbol rest

getDurableObjectNamespace ::
    forall symbol kvs dos bindings.
    (KnownSymbol symbol, RequireDurableObjectNamespace symbol dos) =>
    Proxy symbol ->
    BindingEnv kvs dos bindings ->
    DurableObjectNamespace
getDurableObjectNamespace proxy (BindingEnv _kvs dos) =
    case Map.lookup name dos of
        Nothing -> error ("getDurableObjectNamespace: no dos binding registered under " <> show name)
        Just namespace -> namespace
  where
    name :: Text
    name = Text.pack (symbolVal proxy)

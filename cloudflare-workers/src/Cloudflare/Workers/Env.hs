module Cloudflare.Workers.Env (
    Bindings,
    BindingEnv,
    BindingType,
    getBinding,
) where

import Data.Kind (Type)
import Data.Proxy (Proxy)
import GHC.TypeLits (Symbol)

type Bindings = [(Symbol, Type)]

data BindingEnv (kvs :: [Symbol]) (dos :: [Symbol]) (bindings :: Bindings)

type family BindingType (symbol :: Symbol) (bindings :: Bindings) :: Type where
    BindingType symbol ('(symbol, ty) ': _rest) = ty
    BindingType symbol (_Other ': rest) = BindingType symbol rest

getBinding ::
    Proxy symbol ->
    BindingEnv kvs dos bindings ->
    BindingType symbol bindings
getBinding = error "umimplemented"

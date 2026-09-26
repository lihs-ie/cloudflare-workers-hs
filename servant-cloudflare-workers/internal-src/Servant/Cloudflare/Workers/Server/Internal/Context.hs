{-# LANGUAGE ScopedTypeVariables #-}

{- |
Context definitions adapted from @servant-server-0.20.3.0@
@Servant.Server.Internal.Context@.

Copyright (c) 2014-2016, Zalora South East Asia Pte Ltd,
2016-2018 Servant Contributors. Distributed under BSD-3-Clause.
This port removes the WAI-facing server implementation and keeps only the
context operations needed by the Workers interpreter.
-}
module Servant.Cloudflare.Workers.Server.Internal.Context (
    Context (..),
    HasContextEntry (..),
    NamedContext (..),
    descendIntoNamedContext,
) where

import Data.Kind (Type)
import Data.Proxy (Proxy (Proxy))
import GHC.TypeLits (Symbol)

data Context (context :: [Type]) where
    EmptyContext :: Context '[]
    (:.) :: x -> Context xs -> Context (x ': xs)

infixr 5 :.

class HasContextEntry (context :: [Type]) (value :: Type) where
    getContextEntry :: Context context -> value

instance
    {-# OVERLAPPABLE #-}
    (HasContextEntry xs val) =>
    HasContextEntry (notIt ': xs) val
    where
    getContextEntry (_ :. xs) = getContextEntry xs

instance {-# OVERLAPPING #-} HasContextEntry (val ': xs) val where
    getContextEntry (x :. _) = x

newtype NamedContext (name :: Symbol) (subContext :: [Type]) = NamedContext (Context subContext)

descendIntoNamedContext ::
    forall context name subContext.
    (HasContextEntry context (NamedContext name subContext)) =>
    Proxy (name :: Symbol) ->
    Context context ->
    Context subContext
descendIntoNamedContext Proxy context =
    let NamedContext subContext = getContextEntry context :: NamedContext name subContext
     in subContext

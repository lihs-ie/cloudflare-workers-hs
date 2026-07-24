module Cloudflare.Workers.Binding.DurableObject () where

import Data.Text (Text)

import Cloudflare.Workers.HTTP (Request, Response, Status (Status), createResponse)

data DurableObject = DurableObjectSTUB deriving stock (Show, Eq)

data DurableObjectID = DurableObjectIDSTUB deriving stock (Show, Eq)

data DurableObjectNamespace = DurableObjectNamespaceSTUB deriving stock (Show, Eq)

durableObjectIDFrom :: Text -> DurableObjectID
durableObjectIDFrom _name = DurableObjectIDSTUB

durableObjectGet :: DurableObjectNamespace -> DurableObjectID -> DurableObject
durableObjectGet _namespace _id = DurableObjectSTUB

durableObjectFetch :: DurableObject -> Request -> IO Response
durableObjectFetch _durableObject _request = pure (createResponse (Status 200) [] mempty)

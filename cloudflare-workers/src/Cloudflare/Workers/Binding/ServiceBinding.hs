module Cloudflare.Workers.Binding.ServiceBinding (
    ServiceBinding (..),
    ServiceBindingError (..),
    serviceFetch,
    serviceCall,
) where

import Cloudflare.Workers.Binding.DurableObject (DurableObjectValue (DurableObjectValue))
import Cloudflare.Workers.HTTP (Request, Response)
import Cloudflare.Workers.Internal.FFI.ServiceBinding (serviceBindingCallViaFFI, serviceBindingFetchViaFFI)
import Control.Exception (Exception, throwIO)
import Data.Text (Text)
import GHC.Wasm.Prim (JSVal)

newtype ServiceBinding = ServiceBinding JSVal

data ServiceBindingError
    = ServiceFetchFailed Text
    | ServiceCallFailed Text
    deriving stock (Show, Eq)

instance Exception ServiceBindingError

serviceFetch :: ServiceBinding -> Request -> IO Response
serviceFetch (ServiceBinding serviceJSVal) request = do
    outcome <- serviceBindingFetchViaFFI serviceJSVal request
    either (throwIO . ServiceFetchFailed) pure outcome

serviceCall :: ServiceBinding -> Text -> [DurableObjectValue] -> IO (Either ServiceBindingError DurableObjectValue)
serviceCall (ServiceBinding serviceJSVal) methodName args = do
    outcome <- serviceBindingCallViaFFI serviceJSVal methodName (map unwrapDurableObjectValue args)
    pure (either (Left . ServiceCallFailed) (Right . DurableObjectValue) outcome)
  where
    unwrapDurableObjectValue :: DurableObjectValue -> JSVal
    unwrapDurableObjectValue (DurableObjectValue value) = value

-- This fixture must compile on the host: the plugin erases JS exports and
-- replaces imports with explicit failures, preserving ordinary declarations.
module Support.HostPlugin (foreignValue, ordinaryValue) where
foreign import javascript unsafe "42" foreignValue :: IO Int
foreign export javascript "ordinaryValue" ordinaryValue :: IO Int
ordinaryValue :: IO Int
ordinaryValue = pure 42

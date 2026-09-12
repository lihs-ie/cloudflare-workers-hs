{-# LANGUAGE CPP #-}
module Main (main) where
import GHC.Wasm.Prim (JSVal)
import Quickstart.Runtime
#ifdef WASM_COVERAGE
import Support.Coverage (withCoverage)
#endif
main :: IO ()
main = pure ()
#ifdef WASM_COVERAGE
coverage_redirectFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_redirectFetch argument0 argument1 argument2 = withCoverage (redirectFetch argument0 argument1 argument2)
foreign export javascript "fetch" coverage_redirectFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_managementFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_managementFetch argument0 argument1 argument2 = withCoverage (managementFetch argument0 argument1 argument2)
foreign export javascript "management" coverage_managementFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_exportFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_exportFetch argument0 argument1 argument2 = withCoverage (exportFetch argument0 argument1 argument2)
foreign export javascript "exportApi" coverage_exportFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_recoveryFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_recoveryFetch argument0 argument1 argument2 = withCoverage (recoveryFetch argument0 argument1 argument2)
foreign export javascript "recovery" coverage_recoveryFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_aggregationQueue :: JSVal -> JSVal -> JSVal -> IO ()
coverage_aggregationQueue argument0 argument1 argument2 = withCoverage (aggregationQueue argument0 argument1 argument2)
foreign export javascript "aggregation" coverage_aggregationQueue :: JSVal -> JSVal -> JSVal -> IO ()
coverage_generationQueue :: JSVal -> JSVal -> JSVal -> IO ()
coverage_generationQueue argument0 argument1 argument2 = withCoverage (generationQueue argument0 argument1 argument2)
foreign export javascript "quickstartGeneration" coverage_generationQueue :: JSVal -> JSVal -> JSVal -> IO ()
coverage_recoveryQueue :: JSVal -> JSVal -> JSVal -> IO ()
coverage_recoveryQueue argument0 argument1 argument2 = withCoverage (recoveryQueue argument0 argument1 argument2)
foreign export javascript "recoveryIngest" coverage_recoveryQueue :: JSVal -> JSVal -> JSVal -> IO ()
coverage_maintenanceScheduled :: JSVal -> JSVal -> JSVal -> IO ()
coverage_maintenanceScheduled argument0 argument1 argument2 = withCoverage (maintenanceScheduled argument0 argument1 argument2)
foreign export javascript "maintenance" coverage_maintenanceScheduled :: JSVal -> JSVal -> JSVal -> IO ()
coverage_coordinatorRequest :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_coordinatorRequest argument0 argument1 argument2 = withCoverage (coordinatorRequest argument0 argument1 argument2)
foreign export javascript "coordinator" coverage_coordinatorRequest :: JSVal -> JSVal -> JSVal -> IO JSVal
coverage_coordinatorAlarmEntry :: JSVal -> IO ()
coverage_coordinatorAlarmEntry argument0 = withCoverage (coordinatorAlarmEntry argument0)
foreign export javascript "coordinatorAlarm" coverage_coordinatorAlarmEntry :: JSVal -> IO ()
#else
foreign export javascript "fetch" redirectFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign export javascript "management" managementFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign export javascript "exportApi" exportFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign export javascript "recovery" recoveryFetch :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign export javascript "aggregation" aggregationQueue :: JSVal -> JSVal -> JSVal -> IO ()
foreign export javascript "quickstartGeneration" generationQueue :: JSVal -> JSVal -> JSVal -> IO ()
foreign export javascript "recoveryIngest" recoveryQueue :: JSVal -> JSVal -> JSVal -> IO ()
foreign export javascript "maintenance" maintenanceScheduled :: JSVal -> JSVal -> JSVal -> IO ()
foreign export javascript "coordinator" coordinatorRequest :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign export javascript "coordinatorAlarm" coordinatorAlarmEntry :: JSVal -> IO ()
#endif

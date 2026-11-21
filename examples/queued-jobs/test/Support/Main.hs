{-# LANGUAGE CPP #-}
module Main (main) where
#ifdef WASM_COVERAGE
import Trace.Hpc.Reflect (examineTix)
import Data.Text qualified as CoverageText
import WorkersSupport.Interop (textToJSVal)
#endif
import GHC.Wasm.Prim (JSVal)
import Support.JobsFailures qualified as Jobs
import Support.QueueContracts qualified as Queue

main :: IO ()
main = pure ()

jobsFailure :: JSVal -> JSVal -> JSVal -> IO JSVal
jobsFailure = Jobs.jobsFailure
foreign export javascript "jobsFailure" jobsFailure :: JSVal -> JSVal -> JSVal -> IO JSVal

queueContract :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal
queueContract = Queue.queueContract
foreign export javascript "queueContract" queueContract :: JSVal -> JSVal -> JSVal -> JSVal -> IO JSVal

#ifdef WASM_COVERAGE
coverage :: IO JSVal
coverage = textToJSVal . CoverageText.pack . show =<< examineTix
foreign export javascript "coverage" coverage :: IO JSVal
#endif

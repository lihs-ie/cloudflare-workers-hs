module Support.Coverage (withCoverage) where

import Control.Exception (finally, throwIO)
import ExampleSupport.Interop (decodeEnveloped, textToJSVal)
import Trace.Hpc.Reflect (examineTix)
import Data.Text qualified as Text
import GHC.Wasm.Prim (JSVal)

-- Only linked by the explicit instrumentation flag. Each invocation is observed
-- in its own I/O scope, including newly created Workflow and DO reactors.
withCoverage :: IO a -> IO a
withCoverage action = action `finally` collect
  where
    collect = do
      snapshot <- examineTix >>= textToJSVal . Text.pack . show
      -- Force the returned envelope: an async import returning () can otherwise
      -- discard the promise instead of waiting for upload completion.
      result <- upload snapshot
      decodeEnveloped (const (pure ())) result >>= either (throwIO . userError . Text.unpack) pure

foreign import javascript safe
  "(async()=>{try{const response=await fetch(WASM_COVERAGE_ENDPOINT,{method:'POST',body:$1});if(!response.ok){throw new Error('Coverage upload failed: '+response.status);}return {ok:true,value:null};}catch(error){return {ok:false,message:String(error)};}})()"
  upload :: JSVal -> IO JSVal

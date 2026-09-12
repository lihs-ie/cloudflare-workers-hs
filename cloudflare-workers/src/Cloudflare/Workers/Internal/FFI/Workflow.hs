module Cloudflare.Workers.Internal.FFI.Workflow where

import GHC.Wasm.Prim (JSVal)
import Control.Exception (Exception)
import Data.Text (Text)
import Data.Text qualified as Text

-- Internal exception retains the native engine control error object. Converting
-- pause/restart/terminate aborts to strings changes how the engine classifies them.
data WorkflowNativeError = WorkflowNativeError Text JSVal
instance Show WorkflowNativeError where
    show (WorkflowNativeError message _) = Text.unpack message
instance Exception WorkflowNativeError

foreign import javascript safe
    "(async()=>{try{return {ok:true,value:await $1.create(JSON.parse($2,(key,value)=>{if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new TypeError('Workflow JSON number exceeds the safe integer range');return value}))}}catch(e){return {ok:false,message:String(e),error:e}}})()"
    jsWorkflowCreate :: JSVal -> JSVal -> IO JSVal
foreign import javascript safe
    "(async()=>{try{return {ok:true,value:await $1.get($2)}}catch(e){return {ok:false,message:String(e),error:e}}})()"
    jsWorkflowGet :: JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "$1.id"
    jsInstanceIdentifier :: JSVal -> IO JSVal
foreign import javascript safe
    """
    (async()=>{
      try { return {ok:true,value:JSON.stringify(await $1.status())}; }
      catch(error) {
        const failure={ok:false,message:String(error),error};
        // The platform can reject status immediately after a successful control.
        // Never repeat the control operation, hide permission errors, or invent a state.
        if(String(error)!=='Error: internal error') { return failure; }
        const deadline=Date.now()+2000;
        for(let attempt=0;attempt<8;attempt++) {
          await new Promise(resolve=>setTimeout(resolve,Math.min(250,Math.max(0,deadline-Date.now()))));
          const remaining=deadline-Date.now();
          if(remaining<=0) { return failure; }
          let timer;
          try {
            const status=await Promise.race([
              Promise.resolve().then(()=>$1.status()),
              new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Status observation timed out')),remaining);})
            ]);
            return {ok:true,value:JSON.stringify(status)};
          } catch(next) {
            if(String(next)!=='Error: internal error') { return failure; }
          } finally { clearTimeout(timer); }
        }
        return failure;
      }
    })()
    """
    jsWorkflowStatus :: JSVal -> IO JSVal
foreign import javascript safe
    "(async()=>{try{await $1.sendEvent(JSON.parse($2,(key,value)=>{if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new TypeError('Workflow JSON number exceeds the safe integer range');return value}));return {ok:true,value:null}}catch(e){return {ok:false,message:String(e),error:e}}})()"
    jsWorkflowSendEvent :: JSVal -> JSVal -> IO JSVal
foreign import javascript safe
    "(async()=>{try{await $1[$2]();return {ok:true,value:null}}catch(e){return {ok:false,message:String(e),error:e}}})()"
    jsWorkflowControl :: JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "({step:$1,NonRetryableError:$2})"
    jsWorkflowStep :: JSVal -> JSVal -> IO JSVal

-- This mailbox is scoped to the entire step.do Promise, including retries.
-- No Haskell callback pointer is exposed to JavaScript or released per attempt.
-- Each native callback waits until Haskell resolves its own request Promise.
foreign import javascript unsafe
    """
    (()=>{
      const state={queue:[],pending:new Set(),finished:null,wake:null,closed:false};
      const notify=()=>{const wake=state.wake;state.wake=null;wake?.()};
      const callback=(ctx)=>{
        if(state.closed) return Promise.reject(new $1.NonRetryableError('Haskell workflow step scope closed'));
        return new Promise((resolve,reject)=>{
          const call={ctx,resolve,reject};
          state.pending.add(call);state.queue.push(call);notify();
        });
      };
      Promise.resolve().then(()=>$1.step.do($2,JSON.parse($3),callback)).then(
        value=>{state.finished={ok:true,value:JSON.stringify(value??null)};notify()},
        error=>{state.finished={ok:false,message:String(error),name:error?.name ?? 'Error',error,nonRetryable:state.nonRetryable===true};notify()}
      );
      state.NonRetryableError=$1.NonRetryableError;
      return state;
    })()
    """
    jsStartStep :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign import javascript safe
    """
    (async()=>{
      while(!$1.finished && !$1.queue.length) await new Promise(resolve=>{$1.wake=resolve});
      if($1.finished) return {kind:'complete',value:$1.finished};
      return {kind:'call',value:$1.queue.shift()};
    })()
    """
    jsNextStepMessage :: JSVal -> IO JSVal
foreign import javascript unsafe "$1.kind === 'call'"
    jsIsStepCall :: JSVal -> IO Bool
foreign import javascript unsafe "$1.value"
    jsMessageValue :: JSVal -> IO JSVal
foreign import javascript unsafe "JSON.stringify($1.ctx)"
    jsStepContext :: JSVal -> IO JSVal
foreign import javascript unsafe
    """
    (()=>{
      $1.pending.delete($2);
      if($3) {
        try { $2.resolve(JSON.parse($5,(key,value)=>{if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new TypeError('Workflow JSON number exceeds the safe integer range');return value})); }
        catch(error) { $1.nonRetryable=true; $2.reject(new $1.NonRetryableError(String(error))); }
      }
      else { if($4) $1.nonRetryable=true; $2.reject($4 ? new $1.NonRetryableError($5) : new Error($5)); }
    })()
    """
    jsResolveStepCall :: JSVal -> JSVal -> Bool -> Bool -> JSVal -> IO ()
foreign import javascript unsafe
    """
    (()=>{
      $1.closed=true;
      for(const call of $1.pending) call.reject(new $1.NonRetryableError('Haskell workflow step scope closed'));
      $1.pending.clear();$1.queue.length=0;
      const wake=$1.wake;$1.wake=null;wake?.();
    })()
    """
    jsCloseStep :: JSVal -> IO ()
foreign import javascript safe
    "(async()=>{try{await $1.step.sleep($2,$3);return {ok:true,value:null}}catch(e){return {ok:false,message:String(e),error:e}}})()"
    jsWorkflowSleep :: JSVal -> JSVal -> Double -> IO JSVal
foreign import javascript safe
    "(async()=>{try{await $1.step.sleepUntil($2,$3);return {ok:true,value:null}}catch(e){return {ok:false,message:String(e),error:e}}})()"
    jsWorkflowSleepUntil :: JSVal -> JSVal -> Double -> IO JSVal
foreign import javascript safe
    "(async()=>{try{return {ok:true,value:JSON.stringify(await $1.step.waitForEvent($2,JSON.parse($3)))}}catch(e){return {ok:false,message:String(e),error:e}}})()"
    jsWorkflowWaitForEvent :: JSVal -> JSVal -> JSVal -> IO JSVal
foreign import javascript unsafe "JSON.stringify({payload:$1.payload,instanceIdentifier:$1.instanceId,timestamp:$1.timestamp.toISOString()})"
    jsWorkflowEvent :: JSVal -> IO JSVal
foreign import javascript safe
    "(async()=>{try{return {ok:true,value:JSON.parse($1,(key,value)=>{if(typeof value==='number'&&(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new TypeError('Workflow JSON number exceeds the safe integer range');return value})}}catch(error){return {ok:false,message:String(error)}}})()"
    jsWorkflowJSONValue :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.ok === false && ($1.nonRetryable === true || $1.name === 'NonRetryableError')"
    jsFailureNonRetryable :: JSVal -> IO Bool
foreign import javascript unsafe "$1.message"
    jsFailureMessage :: JSVal -> IO JSVal

foreign import javascript unsafe "$1.error"
    jsFailureNativeError :: JSVal -> IO JSVal
foreign import javascript unsafe "({ok:false,nativeError:$1,message:String($1)})"
    jsWorkflowNativeFailure :: JSVal -> IO JSVal

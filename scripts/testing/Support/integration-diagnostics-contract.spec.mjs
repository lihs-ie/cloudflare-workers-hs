import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Run the real integration callbacks against broken boundaries. Failure is the
// expected child result; it must never be accepted as a passing integration run.
function diagnose({
  source,
  name,
  setup,
  expected,
  register = "",
  status = 1,
  verify = "",
  verifyCleanup = "",
}) {
  const program = `
    import nativeTest from "node:test";
    const { moduleBoundary } = await import(${JSON.stringify(new URL("./module-boundaries.mjs", import.meta.url).href)});
    globalThis.nativeTest = nativeTest;
    const cases = new Map();
    const caseOptions = new Map();
    const starts = [];
    const stops = [];
    const { registerHooks } = await import("node:module");
    globalThis.registration = { cases, starts, stops, caseOptions };
    const testModule = "data:text/javascript," + encodeURIComponent("export default globalThis.nativeTest; export const test = (name, ...args) => { globalThis.registration.cases.set(name, args.at(-1)); globalThis.registration.caseOptions.set(name, args.length > 1 ? args[0] : undefined); }; export const before = callback => globalThis.registration.starts.push(callback); export const after = callback => globalThis.registration.stops.push(callback);");
    registerHooks({ resolve(specifier, context, next) { if (specifier === "node:test") { return {url: testModule, shortCircuit:true}; } if (specifier === "node:timers/promises") { return {url:"data:text/javascript,export const setTimeout = async () => {};", shortCircuit:true}; } if (globalThis.moduleBoundaries?.[specifier]) { return {url:"data:text/javascript," + encodeURIComponent(globalThis.moduleBoundaries[specifier]), shortCircuit:true}; } return next(specifier, context); }});
    const runtime = { base: "http://diagnostic.invalid", state: "/diagnostic", logPath: "/diagnostic/wrangler.log", evidence: "/diagnostic", close: async () => {}, dispose: async () => {} };
    const source = new URL(${JSON.stringify(`../../../${source}`)}, ${JSON.stringify(import.meta.url)});
    moduleBoundary(new URL(${JSON.stringify(["/realtime/", "/minimal/", "/static-assets/"].some((part) => source.includes(part)) ? "../Support/dev.mjs" : "../Support/dev-runtime.mjs")}, source), { namedExports: { startRuntime: async options => { runtime.startOptions = options; return runtime; }, startDev: async options => { runtime.startOptions = options; return runtime; } }});
    ${setup}
    const imported = await import(source.href);
    ${register}
    for (const start of starts) { await start(); }
    try { await cases.get(${JSON.stringify(name)})({ diagnostic: message => console.error(message), after: callback => stops.push(callback) });
    ${verify}
    console.error("callback completed"); }
    finally { for (const stop of stops) { await stop(); } }
    ${verifyCleanup}
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--input-type=module",
      "--eval",
      program,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, status, result.stdout + result.stderr);
  assert.match(result.stderr, expected);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|is not a function/);
}

const jobs = "examples/library-examples/test/integration/jobs.spec.mjs";
const fastClock = `let time = 0; Date.now = () => (time += 10000);`;
test("missing Queue delivery reports the application identifier", () => {
  diagnose({
    source: jobs,
    name: "a failed DO RPC is retried and acknowledged only after persistence",
    setup: `${fastClock}
    globalThis.fetch = async (url, options) => options?.method === "POST" ? new Response("{}") : new Response("missing", {status:404});`,
    expected: /Job retry-once did not complete/,
  });
});
test("missing native redelivery reports the last observed state", () => {
  diagnose({
    source: jobs,
    name: "Queue retries a lost RPC response after commit without duplicating the SQL effect",
    setup: `${fastClock}
    globalThis.fetch = async (url, options) => new Response(JSON.stringify(options?.method === "POST" ? {} : {updates:1, attempts:1}));`,
    expected: /No native Queue redelivery observed:.*attempts/,
  });
});
for (const transport of ["bytes-single", "message-delay"]) {
  test(`missing ${transport} delivery reports the transport`, () => {
    diagnose({
      source:
        "examples/library-examples/test/integration/queue-producers.cases.mjs",
      name: `Haskell Queue ${transport} delivers encoded JSON to the typed consumer`,
      register: "imported.registerQueueProducerCases(() => runtime);",
      setup: `${fastClock}
      globalThis.fetch = async (url, options) => options?.method === "POST" ? new Response(JSON.stringify({accepted:JSON.parse(options.body).identifier, transport:${JSON.stringify(transport)}})) : new Response("missing", {status:404});`,
      expected: new RegExp(`${transport} never reached the typed consumer`),
    });
  });
}
const workflow = "examples/workflows/test/integration/workflow.spec.mjs";
const fastPerformance = `let time = 0; Object.defineProperty(performance, "now", { value: () => (time += 10000) }); globalThis.setTimeout = (callback) => { queueMicrotask(callback); return 0; };`;
test("Workflow approval timeout includes status, audit and log path", () => {
  diagnose({
    source: workflow,
    name: "real Workflow waits for approval then retries without duplicating its side effect",
    setup: `${fastPerformance}
    globalThis.fetch = async () => new Response(JSON.stringify({attempts:[], state:"WorkflowRunning"}));`,
    expected:
      /workflow never reached approval checkpoint:.*\/diagnostic\/wrangler.log/,
  });
});
test("Workflow terminal-state timeout includes the requested state and log path", () => {
  diagnose({
    source: workflow,
    name: "native event timeout fails without running the post-event step",
    setup: `${fastPerformance}
    globalThis.fetch = async () => new Response(JSON.stringify({state:"WorkflowRunning"}));`,
    expected:
      /workflow never reached WorkflowErrored:.*\/diagnostic\/wrangler.log/,
  });
});
test("Workflow HTTP failure includes the operation, body and log path", () => {
  diagnose({
    source: workflow,
    name: "native event timeout fails without running the post-event step",
    setup: `globalThis.fetch = async () => new Response("upstream unavailable", {status:503});`,
    expected:
      /POST \/__fixture\/create: upstream unavailable; \/diagnostic\/wrangler.log/,
  });
});
test("Workflow unexpected failure preserves the native error payload", () => {
  diagnose({
    source: workflow,
    name: "real Workflow waits for approval then retries without duplicating its side effect",
    setup: `
    globalThis.fetch = async (url, options) => new Response(JSON.stringify(options?.method === "POST" ? {} : url.endsWith("/audit") ? {attempts:[{step:"prepare-request",attempt:1},{step:"await-approval",attempt:1}], effects:{total:0}} : {state:url.endsWith("/retry-approval") && globalThis.approved ? "WorkflowErrored" : "WorkflowWaiting", output:null, error:"native diagnostic"}));
    const fetch = globalThis.fetch; globalThis.fetch = (url, options) => { if(url.endsWith("/approve")) { globalThis.approved=true; } return fetch(url, options); };`,
    expected:
      /unexpected workflow failure.*native diagnostic.*\/diagnostic\/wrangler.log/,
  });
});
test("Workflow missing execution checkpoint identifies the step", () => {
  diagnose({
    source: workflow,
    name: "explicit event wake-up after process restart replays the UTC execution gate",
    setup: `${fastPerformance.replace("time += 10000", "time += 1000")}
    globalThis.fetch = async (url, options) => new Response(JSON.stringify(options?.method === "POST" ? {} : url.endsWith("/audit") ? {attempts:[{step:"await-approval"}]} : {state:"WorkflowWaiting",output:null}));
`,
    expected:
      /missing checkpoint scheduled-execution; \/diagnostic\/wrangler.log/,
  });
});
test("stream close deadline rejects a response whose reader was never closed", () => {
  diagnose({
    source:
      "examples/library-examples/test/integration/client-stream.cases.mjs",
    name: "HTTP streaming callback early return closes the actual upstream response",
    register: "imported.registerClientStreamTests(() => runtime);",
    setup: `let time=0; Date.now=()=> (time+=1000); globalThis.setTimeout=(callback)=>{queueMicrotask(callback);return 0;}; runtime.clientHttpFixture={closedStreamResponses:()=>0}; globalThis.fetch=async()=>new Response(JSON.stringify({bytes:[0,128,255]}));`,
    expected: /0 !== 1/,
  });
});
test("KV propagation deadline rejects an indefinitely stale value", () => {
  diagnose({
    source: "examples/library-examples/test/integration/storage.spec.mjs",
    name: "regional KV scenarios preserve updates and expose an absolute expiration",
    setup: `${fastClock} globalThis.fetch=async()=>new Response(JSON.stringify({value:"initial"}));`,
    expected: /initial[\s\S]*updated/,
  });
});
for (const [name, response, expected] of [
  [
    "native-shaped Tail events reach the real Haskell entrypoint",
    { delivered: true },
    /tail outcome=ok/,
  ],
  [
    "workerd delivers the producer event to the configured Haskell Tail Worker",
    {},
    /Real runtime Tail envelope should contain the guide HTTP event/,
  ],
]) {
  test(`missing logs are rejected: ${name}`, () => {
    diagnose({
      source: "examples/library-examples/test/integration/library.spec.mjs",
      name,
      setup: `let time=0; Date.now=()=> (time+=1000); globalThis.setTimeout=(callback)=>{queueMicrotask(callback);return 0;}; globalThis.moduleBoundaries={"node:fs/promises":"export const readFile = async () => '';"}; globalThis.fetch=async()=>new Response(JSON.stringify(${JSON.stringify(response)}));`,
      expected,
    });
  });
}
test("missing structured logs cannot silently satisfy level filtering", () => {
  diagnose({
    source: "examples/library-examples/test/integration/logging.spec.mjs",
    name: "native structured logging profile diagnostics filters levels and preserves errors",
    setup: `let time=0; Date.now=()=> (time+=1000); globalThis.moduleBoundaries={"node:fs/promises":"export const readFile = async () => '';"}; globalThis.fetch=async()=>new Response(JSON.stringify({profile:"diagnostics",reported:true}));`,
    expected: /ERR_ASSERTION[\s\S]*debug/,
  });
});
test("a silent WebSocket rejects the pending message with its timeout diagnostic", () => {
  diagnose({
    source: "examples/realtime/test/integration/realtime.spec.mjs",
    name: "two hibernating sockets broadcast text and binary, retain attachments and SQL history",
    setup: `
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => { this.dispatchEvent(new MessageEvent("message", {data:"connected:fixture"})); this.dispatchEvent(new Event("open")); }); }
      close() {} send() {}
    };
    globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
    globalThis.clearTimeout = () => {};`,
    expected: /WebSocket message timeout/,
  });
});
test("a silent upgrade handshake rejects with the handshake diagnostic", () => {
  diagnose({
    source: "examples/realtime/test/integration/realtime.spec.mjs",
    name: "WebSocket Upgrade token is case-insensitive and HTTP method is enforced",
    setup: `
    globalThis.moduleBoundaries = {"node:http": "import { EventEmitter } from 'node:events'; export function request() { const result=new EventEmitter(); result.setTimeout=(_delay, callback)=>{result.timeout=callback;}; result.destroy=error=>result.emit('error', error); result.end=()=>queueMicrotask(result.timeout); return result; }"};`,
    expected: /handshake timeout/,
  });
});
// These are tests of the integration assertions, not claims that local R2
// implements encryption or infrequent-access billing.
test("archive contract accepts native SSE-C metadata only with rejected foreign keys", () => {
  diagnose({
    source: "examples/library-examples/test/integration/archives.cases.mjs",
    name: "encrypted multipart archive resumes with per-part keys and reports local capability honestly",
    register: "imported.registerArchiveTests(() => runtime);",
    status: 0,
    expected: /callback completed/,
    setup: `
    const calls=[]; const bytes=new Uint8Array(5*1024*1024+3).fill(65); bytes.set([0,128,255],bytes.length-3);
    globalThis.fetch=async(url, options)=>{calls.push([url,options?.method]);
      if(url.includes('/cleanup')) { return Response.json({deleted:true}); }
      if(url.includes('/missing-key')) { return new Response('Archive encryption is unavailable',{status:503}); }
      if(url.includes('/inspect')) { return Response.json({keyMetadataPresent:true,wrongKeyReadable:false,noKeyReadable:false}); }
      if(url.includes('/wrong-key')) { return new Response('rejected',{status:502}); }
      if(options?.method==='POST') { return Response.json({size:bytes.length,keyMetadataPresent:true},{status:201}); }
      return new Response(bytes);
    };`,
    verify: `if(calls.length!==6 || !calls.at(-1)[0].includes('/cleanup') || calls.at(-1)[1]!=='DELETE') { throw new Error('archive requests or cleanup missing'); }`,
  });
});
test("archive contract accepts retained InfrequentAccess class and always cleans up", () => {
  diagnose({
    source: "examples/library-examples/test/integration/archives.cases.mjs",
    name: "InfrequentAccess archive reports native storage class and preserves content",
    register: "imported.registerArchiveTests(() => runtime);",
    status: 0,
    expected: /callback completed/,
    setup: `
    const calls=[]; globalThis.fetch=async(url,options)=>{calls.push([url,options?.method]);
      if(url.includes('/cleanup')) { return Response.json({deleted:true}); }
      if(url.includes('/inspect')) { return Response.json({storageClass:'InfrequentAccess'}); }
      if(options?.method==='POST') { return Response.json({size:22,storageClass:'R2InfrequentAccess'},{status:201}); }
      return new Response('retained audit archive');
    };`,
    verify: `if(calls.length!==4 || calls.at(-1)[1]!=='DELETE') { throw new Error('archive cleanup missing'); }`,
  });
});
for (const brokenDownload of [false, true]) {
  test(`attachment SSE-C supported assertion path: broken download ${brokenDownload}`, () => {
    diagnose({
      source:
        "examples/library-examples/test/integration/attachments.cases.mjs",
      name: "SSE-C reports native capability and checks key rejection when supported",
      register: "imported.registerAttachmentsTests(() => runtime);",
      status: brokenDownload ? 1 : 0,
      expected: brokenDownload
        ? /diagnostic download failure/
        : /callback completed/,
      setup: `
      const calls=[]; globalThis.fetch=async(url,options)=>{calls.push(url);
        if(url.endsWith('/capability')) { return Response.json({correctKeyReadable:true,keyMetadataPresent:true,wrongKeyReadable:false,noKeyReadable:false}); }
        if(options.method==='PUT') { return new Response('',{status:201}); }
        if(url.includes('/wrong-key/')) { return new Response('Attachment storage failed',{status:502}); }
        if(url.includes('/valid-key/')) { return ${brokenDownload ? "new Response('diagnostic download failure',{status:503})" : "new Response(new Uint8Array([0,255,128]))"}; }
        return new Response('',{status:404});
      };`,
      verify: `if(calls.length!==5) { throw new Error('attachment assertion did not finish'); }`,
    });
  });
}
for (const initial of [undefined, 3]) {
  for (const [name, path, mode] of [
    [
      "malformed stream echo fails decoding and the next request recovers",
      "/stream-echo",
      "malform",
    ],
    [
      "HTTP streamed POST preserves binary chunks and headers in one dispatch",
      "/stream-echo",
      "stream",
    ],
    [
      "HTTP client aborts a slow destination at the configured timeout",
      "/slow",
      "slow",
    ],
    [
      "HTTP buffered GET retries interrupted response bodies and then recovers",
      "/",
      "retry",
    ],
    [
      "HTTP interrupted body retries stop at the limit and the next request succeeds",
      "/",
      "exhaust",
    ],
    [
      "HTTP streamed POST is not replayed after connection loss and a new request succeeds",
      "/stream-echo",
      "disconnect",
    ],
  ]) {
    test(`integration counter starts at ${initial}: ${mode}`, () => {
      diagnose({
        source:
          "examples/library-examples/test/integration/client-options.cases.mjs",
        name,
        register: "imported.registerClientOptionsTests(() => runtime);",
        status: 0,
        expected: /callback completed/,
        setup: `
        let count=${JSON.stringify(initial)}, calls=0, fault;
        runtime.clientHttpFixture={ stats:()=>({[${JSON.stringify(path)}]:count}), malformNextStreamResponse:()=>{fault='malform';}, disconnectNextStream:()=>{fault='disconnect';}, interruptResponseBodies:value=>{fault=value;} };
        globalThis.fetch=async()=>{ calls++; count=(count??0)+${["retry", "exhaust"].includes(mode) ? "(calls===1?3:1)" : "1"};
          const result={method:'POST',bytes:[0,1,127,128,255,10,42],contentType:'application/octet-stream',trace:'stream-regression',attempts:count};
          if(${JSON.stringify(mode)}==='malform' && calls===1) { if(fault!=='malform') { throw new Error('fault was not armed'); } return new Response('bad stream',{status:500}); }
          if(${JSON.stringify(mode)}==='disconnect' && calls===1) { if(fault!=='disconnect') { throw new Error('fault was not armed'); } return Response.json({error:'ConnectionError',transport:'FetchNetworkFailure'}); }
          if(${JSON.stringify(mode)}==='slow') { return Response.json({outcome:{error:'ConnectionError',transport:'FetchTimedOut'}}); }
          if(${JSON.stringify(mode)}==='retry') { if(fault!==2) { throw new Error('wrong retry fault'); } return Response.json({outcome:{result:{status:200}}}); }
          if(${JSON.stringify(mode)}==='exhaust') { if(fault!==3) { throw new Error('wrong exhausted fault'); } return Response.json({outcome:calls===1?{error:'ConnectionError',transport:'FetchNetworkFailure'}:{result:{status:200}}}); }
          return Response.json(result);
        };`,
        verify: `if(calls!==${["malform", "exhaust", "disconnect"].includes(mode) ? 2 : 1}) { throw new Error('missing dispatch'); }`,
      });
    });
  }
}
for (const metrics of [
  { backlogCount: 0, backlogBytes: 0 },
  { backlogCount: 2, backlogBytes: 512 },
]) {
  test(`supported Queue metrics validate safe integer values: ${metrics.backlogCount}`, () => {
    diagnose({
      source:
        "examples/library-examples/test/integration/queue-contracts.cases.mjs",
      name: "native Queue metrics diagnostic distinguishes unsupported from real values",
      register: "imported.registerQueueContractCases(() => runtime);",
      status: 0,
      expected: /callback completed/,
      setup: `let calls=0; globalThis.fetch=async()=>{calls++;return Response.json({status:'supported',metrics:${JSON.stringify(metrics)}});};`,
      verify: `if(calls!==1) { throw new Error('metrics call missing'); }`,
    });
  });
}
test("WebSocket integration handles queued and pending messages plus delayed close observation", () => {
  diagnose({
    source: "examples/realtime/test/integration/realtime.spec.mjs",
    name: "two hibernating sockets broadcast text and binary, retain attachments and SQL history",
    status: 0,
    expected: /callback completed/,
    setup: `
    const sockets=[]; let closing=false, closeReads=0; const nativeTimeout=globalThis.setTimeout;
    globalThis.setTimeout=(callback, delay)=> delay===25 ? (queueMicrotask(callback),0) : nativeTimeout(callback,delay);
    globalThis.WebSocket=class extends EventTarget {
      constructor() { super(); this.identifier='fixture-'+sockets.length; sockets.push(this); queueMicrotask(()=>{this.dispatchEvent(new MessageEvent('message',{data:'connected:'+this.identifier}));this.dispatchEvent(new Event('open'));}); }
      send(value) { const targets=value==='ping'?[this]:sockets; for(const target of targets) { queueMicrotask(()=>target.dispatchEvent(new MessageEvent('message',{data:value==='ping'?'pong':value}))); } }
      close() { if(this===sockets[0]) { closing=true; } }
    };
    globalThis.fetch=async(url)=>{
      if(url.endsWith('/history')) { return Response.json({rows:[[null,null,{tag:'blob',value:[0,128,255]}],[]]}); }
      if(url.endsWith('/connections')) { return Response.json({count:closing?(closeReads++===0?2:1):2,attachments:sockets.map(socket=>socket.identifier)}); }
      throw new Error('unexpected socket request '+url);
    };`,
    verify: `if(sockets.length!==2 || closeReads<2) { throw new Error('delayed close was not observed'); }`,
  });
});
test("concurrent settings assertions support a fresh empty revision history", () => {
  diagnose({
    source: jobs,
    name: "concurrent settings updates preserve every revision and retain the latest three",
    status: 0,
    expected: /callback completed/,
    setup: `
    const saved=[]; globalThis.fetch=async(url,options)=>{
      if(options?.method==='POST') { const result={revision:saved.length+1,settings:JSON.parse(options.body)}; saved.push(result); return Response.json(result); }
      return Response.json(saved.slice(-3).reverse());
    };`,
    verify: `if(saved.length!==8) { throw new Error('concurrent updates missing'); }`,
  });
});

test("unsupported Queue diagnostic requires explicitly absent metrics", () => {
  diagnose({
    source:
      "examples/library-examples/test/integration/queue-contracts.cases.mjs",
    name: "native Queue metrics diagnostic distinguishes unsupported from real values",
    register: "imported.registerQueueContractCases(() => runtime);",
    status: 0,
    expected: /callback completed/,
    setup: `let calls=0; globalThis.fetch=async()=>{calls++;return Response.json({status:'unsupported',metrics:null});};`,
    verify: `if(calls!==1) { throw new Error('metrics call missing'); }`,
  });
});

// Execute the actual assertion callbacks under boundary doubles. These cases
// verify the integration test contracts, not a real WASM upload or recovery.
for (const [example, name, mode] of [
  [
    "minimal",
    "coverage upload rejection propagates and the same reactor recovers",
    "default",
  ],
  [
    "realtime",
    "coverage upload rejection propagates and the same reactor recovers",
    "default",
  ],
  [
    "static-assets",
    "coverage upload rejection propagates and the same reactor recovers",
    "default",
  ],
  [
    "workflows",
    "coverage upload rejection propagates and the next Workflow request recovers",
    "default",
  ],
  [
    "workflows",
    "fixture reactor upload failure is observed independently and the same instance recovers",
    "fixture",
  ],
  [
    "workflows",
    "production reactor upload failure is captured by a subsequent snapshot from the same instance",
    "production-reactor",
  ],
]) {
  test(`upload assertion callback with Node boundary doubles: ${example}/${mode}`, () => {
    diagnose({
      source: `examples/${example}/test/integration/coverage-upload.spec.mjs`,
      name,
      status: 0,
      expected: /callback completed/,
      setup: `
        process.env.WASM_COVERAGE_ENDPOINT='https://assertion-collector.invalid';
        let closed=0; const requests=[];
        runtime.close=runtime.dispose=async()=>{closed++;};
        globalThis.fetch=async url=>{
          const path=new URL(url).pathname; requests.push(new URL(url).pathname+new URL(url).search);
          if(path==='/__coverage/upload-failure') {
            const result={rejected:true,attempts:1,message:'Coverage upload failed: 503'};
            if(${JSON.stringify(mode)}!=='default') {
              result.mode=${JSON.stringify(mode)};result.operations=3;
              result.recovered=${mode === "fixture" ? "{ok:true,state:'WorkflowPaused'}" : "{status:'ok'}"};
              result.confirmed=result.recovered;
            }
            return Response.json(result);
          }
          if(path===${JSON.stringify(example === "static-assets" ? "/api/health" : "/health")}) {
            return Response.json(${example === "static-assets" ? "{status:'ok',runtime:'Haskell/WASM'}" : "{status:'ok'}"});
          }
          throw new Error('unexpected upload assertion request '+url);
        };`,
      verify: `
        if(caseOptions.get(${JSON.stringify(name)}).skip!==false) { throw new Error('coverage callback was not enabled'); }
        const expected=${JSON.stringify(mode === "production-reactor" ? ["/__coverage/upload-failure?mode=production-reactor"] : mode === "fixture" ? ["/__coverage/upload-failure?mode=fixture", "/health"] : ["/__coverage/upload-failure", example === "static-assets" ? "/api/health" : "/health"])};
        if(JSON.stringify(requests)!==JSON.stringify(expected)) { throw new Error('upload/recovery request sequence mismatch'); }
        ${["minimal", "static-assets"].includes(example) ? "if(!runtime.startOptions.config.endsWith('/Support/wrangler-coverage-upload.jsonc')) { throw new Error('coverage upload configuration missing'); }" : "if(runtime.startOptions!==undefined) { throw new Error('unexpected startup options'); }"}`,
      verifyCleanup: `if(closed!==1) { throw new Error('upload assertion cleanup missing'); }`,
    });
  });
}

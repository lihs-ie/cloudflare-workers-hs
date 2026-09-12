// Injected only into test artifacts, never into normal Worker bundles.
let isolate;
let sequence = 0;
const wrapped = new WeakSet();
async function flush() {
  const coverage = globalThis.__workerdCoverage__;
  if (!coverage) { throw new Error("Missing workerd instrumentation"); }
  isolate ??= crypto.randomUUID();
  const body = JSON.stringify({ bundle, isolate, sequence: ++sequence, coverage });
  const response = await fetch(endpoint, { method: "POST", body });
  if (!response.ok) { throw new Error(`Coverage collector failed: ${response.status}`); }
}
function observe(fn) {
  return async function (...args) {
    try { return await fn.apply(this, args); }
    finally { await flush(); }
  };
}
function wrapHandler(value) {
  if (!value) { return value; }
  if (typeof value === "function") { return wrapClass(value); }
  const copy = Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof descriptor.value === "function") { descriptor.value = observe(descriptor.value).bind(value); }
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}
function wrapClass(value) {
  if (typeof value !== "function" || !value.prototype) { return value; }
  for (let prototype = value.prototype; prototype && !["Object", "DurableObject", "WorkerEntrypoint", "WorkflowEntrypoint"].includes(prototype.constructor?.name); prototype = Object.getPrototypeOf(prototype)) {
    if (wrapped.has(prototype)) { continue; }
    wrapped.add(prototype);
    for (const key of Reflect.ownKeys(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (key !== "constructor" && typeof descriptor.value === "function") {
        Object.defineProperty(prototype, key, { ...descriptor, value: observe(descriptor.value) });
      }
    }
  }
  return value;
}

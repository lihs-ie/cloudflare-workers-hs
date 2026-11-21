#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  bindExport,
  createReactor,
  decodeResponse,
  defineWorker,
} from '@cloudflare-workers-hs/runtime';

// The reactor initializer writes 42 to the first byte of exported WASM memory.
const bytes = Uint8Array.from([
  // Header and a void-to-void function type.
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0,
  // One function and one page of linear memory.
  3, 2, 1, 0, 5, 3, 1, 0, 1,
  // Exports: memory and _initialize.
  7, 24, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 11, 95, 105, 110, 105, 116, 105, 97, 108, 105,
  122, 101, 0, 0,
  // _initialize: i32.const 0; i32.const 42; i32.store8; end.
  10, 11, 1, 9, 0, 65, 0, 65, 42, 58, 0, 0, 11,
]);
const module = await WebAssembly.compile(bytes);
const memoryBytes = await createReactor(
  module,
  () => ({}),
  ({ memory }) => {
    assert.ok(memory instanceof WebAssembly.Memory);
    return new Uint8Array(memory.buffer);
  },
);
assert.equal(memoryBytes[0], 42);

const fetch = bindExport({ fetch: () => new Response('Git runtime') }, 'fetch', decodeResponse);
const worker = defineWorker({ fetch });
const response = await worker.fetch(new Request('https://example.com'));
assert.equal(await response.text(), 'Git runtime');
console.log('PASS SHA-pinned runtime: public import, real WASM, response adapter');

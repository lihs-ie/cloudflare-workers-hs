#!/usr/bin/env node
/** Verify the SHA-pinned runtime installed for the example workspace. */
import assert from "node:assert/strict";
import {
  bindExport,
  createReactor,
  decodeResponse,
  decodeVoid,
} from "@cloudflare-workers-hs/runtime";

const bytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 24, 2, 6,
  109, 101, 109, 111, 114, 121, 2, 0, 11, 95, 105, 110, 105, 116, 105, 97, 108, 105, 122, 101,
  0, 0, 10, 4, 1, 2, 0, 11,
]);
const module = await WebAssembly.compile(bytes);
const reactor = await createReactor(module, () => ({}), (exports) => ({
  initialize: bindExport(exports, "_initialize", decodeVoid),
}));
await reactor.initialize();

const fetch = bindExport(
  { fetch: () => new Response("Git runtime") },
  "fetch",
  decodeResponse,
);
const response = await fetch(new Request("https://example.com"));
assert.equal(await response.text(), "Git runtime");
console.log("PASS SHA-pinned runtime: public import, real WASM, response adapter");

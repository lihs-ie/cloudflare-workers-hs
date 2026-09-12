/** Actual upload helpers with reactor doubles: Node coverage, not WASM/platform proof. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

for (const example of ["minimal", "static-assets", "realtime", "workflows"]) {
  test(`${example} upload interception restores fetch and preserves recovery`, async () => {
    const slot = Symbol.for("upload-helper-contract");
    const originalFetch = globalThis.fetch;
    const endpointDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "WASM_COVERAGE_ENDPOINT",
    );
    const forwarded = [];
    // Each behavior is explicitly installed before its first invocation.
    const boundary = {};
    globalThis[slot] = boundary;
    const source =
      `/* ${example} */` +
      "const b=globalThis[Symbol.for('upload-helper-contract')];";
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        if (
          specifier.startsWith("../../worker/") &&
          !specifier.endsWith("runtime")
        ) {
          return {
            url: `data:text/javascript,${encodeURIComponent(source + "export default {fetch:(...args)=>b.fetch(...args)}")}`,
            shortCircuit: true,
          };
        }
        if (specifier === "./runtime" || specifier === "../../worker/runtime") {
          return {
            url: `data:text/javascript,${encodeURIComponent(source + "export async function createFixtureReactor(){return b.reactor} export async function createWorkflowReactor(){return b.reactor}")}`,
            shortCircuit: true,
          };
        }
        return next(specifier, context);
      },
    });
    globalThis.fetch = async (input, init) => {
      forwarded.push([input, init]);
      return Response.json({ ok: true });
    };
    const restored = globalThis.fetch;
    const env = {};
    const context = {};
    try {
      const url = new URL(
        `../../../${example}/test/Support/coverage-upload.ts`,
        import.meta.url,
      );
      const { default: helper } = await import(url.href);
      const invoke = (mode = "production") =>
        helper.fetch(
          new Request(
            `https://helper.test/__coverage/upload-failure?mode=${mode}`,
          ),
          env,
          context,
        );
      const request = new Request("https://helper.test/normal");
      boundary.fetch = async (...args) => {
        assert.deepEqual(args, [request, env, context]);
        return new Response("forwarded");
      };
      assert.equal(
        await (await helper.fetch(request, env, context)).text(),
        "forwarded",
      );
      delete globalThis.WASM_COVERAGE_ENDPOINT;
      assert.equal((await invoke()).status, 409);
      globalThis.WASM_COVERAGE_ENDPOINT = "https://collector.test/upload";
      const upload = async (requestObject) => {
        const input = requestObject
          ? new Request(globalThis.WASM_COVERAGE_ENDPOINT)
          : globalThis.WASM_COVERAGE_ENDPOINT;
        const response = await globalThis.fetch(input);
        if (!response.ok) {
          throw new Error(`Coverage upload failed: ${response.status}`);
        }
      };
      for (const rejection of [
        new Error("expected failure"),
        "primitive failure",
        undefined,
      ]) {
        boundary.fetch = async () => {
          assert.equal(
            (
              await globalThis.fetch(
                new Request(globalThis.WASM_COVERAGE_ENDPOINT),
              )
            ).status,
            503,
          );
          assert.equal(
            (await globalThis.fetch(globalThis.WASM_COVERAGE_ENDPOINT)).status,
            503,
          );
          await globalThis.fetch("https://ordinary.test", { method: "POST" });
          if (rejection !== undefined) {
            throw rejection;
          }
          return new Response("ok");
        };
        const result = await (await invoke()).json();
        assert.equal(result.attempts, 2);
        assert.equal(result.rejected, rejection !== undefined);
        if (rejection !== undefined) {
          assert.equal(
            result.message,
            rejection instanceof Error ? rejection.message : rejection,
          );
        }
        assert.equal(globalThis.fetch, restored);
      }
      assert.equal(forwarded.length, 3);
      const defaultMode = await helper.fetch(
        new Request("https://helper.test/__coverage/upload-failure"),
        env,
        context,
      );
      assert.equal((await defaultMode.json()).rejected, false);
      assert.equal(globalThis.fetch, restored);
      if (example === "workflows") {
        for (const mode of ["fixture", "production-reactor"]) {
          boundary.reactor = {
            async workflowControlFixture(binding, operation) {
              const handle = await binding.get();
              assert.equal(handle.id, "coverage-upload-contract");
              await handle[operation]();
              assert.deepEqual(await handle.status(), { status: "paused" });
              await globalThis.fetch("https://ordinary.test");
              await upload(true);
              return JSON.stringify({ status: "paused" });
            },
            async fetch() {
              await globalThis.fetch("https://ordinary.test");
              await upload(false);
              return Response.json({ ok: true });
            },
          };
          const result = await (await invoke(mode)).json();
          assert.equal(result.rejected, true);
          assert.equal(result.attempts, 1);
          assert.equal(result.operations, 3);
          assert.equal(result.message, "Coverage upload failed: 503");
          assert.deepEqual(result.recovered, result.confirmed);
          assert.equal(globalThis.fetch, restored);
        }
        boundary.reactor.fetch = async () =>
          new Response("bad", { status: 502 });
        await assert.rejects(
          invoke("production-reactor"),
          /Unexpected health status: 502/,
        );
        assert.equal(globalThis.fetch, restored);
        let calls = 0;
        boundary.reactor.workflowControlFixture = async () => {
          if (++calls === 1) {
            throw "primitive rejection";
          }
          return "{}";
        };
        const primitive = await (await invoke("fixture")).json();
        assert.equal(primitive.message, "primitive rejection");
        boundary.reactor.workflowControlFixture = async () => "{}";
        assert.equal((await (await invoke("fixture")).json()).rejected, false);
      }
    } finally {
      hooks.deregister();
      globalThis.fetch = originalFetch;
      if (endpointDescriptor) {
        Object.defineProperty(
          globalThis,
          "WASM_COVERAGE_ENDPOINT",
          endpointDescriptor,
        );
      } else {
        delete globalThis.WASM_COVERAGE_ENDPOINT;
      }
      delete globalThis[slot];
    }
  });
}

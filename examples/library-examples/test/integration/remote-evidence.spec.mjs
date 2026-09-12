import assert from "node:assert/strict";
import { test } from "node:test";
import { observeReadFailure } from "../Support/Remote/ssec-evidence.ts";

test("generic exceptions never prove wrong-key rejection or expose diagnostics", () => {
  for (const error of [new Error("secret-value"), new Error("Access denied (10003)"), new Error("Wrong encryption key"), "secret-value", null]) {
    assert.equal(observeReadFailure(error), "unclassified-error");
  }
});
test("documented service and transfer failure codes remain non-encryption failures", () => {
  for (const code of [10001, 10013, 10043, 10054, 10058]) {
    assert.equal(observeReadFailure(new Error(`GET details omitted (${code})`)), "service-or-transport-error");
  }
});

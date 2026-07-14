// B0 smoke: the workspace wiring itself — the library resolves and the test
// runner executes TypeScript. Real byte-critical tests arrive with B1.
import { test } from "node:test";
import assert from "node:assert/strict";

test("the core package resolves", async () => {
  const core = await import("../src/index.ts");
  assert.equal(typeof core, "object");
});

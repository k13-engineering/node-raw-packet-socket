import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { assertNoReentrancy, nothingScheduled, scheduleMicrotask } from "./scheduling.ts";

describe("scheduling", () => {

  describe("scheduleMicrotask", () => {
    it("should run the callback in a microtask and report it pending until then", async () => {
      let calls = 0;

      const scheduled = scheduleMicrotask(() => {
        calls += 1;
      });

      assert.strictEqual(calls, 0);
      assert.strictEqual(scheduled.pending(), true);

      await Promise.resolve();

      assert.strictEqual(calls, 1);
      assert.strictEqual(scheduled.pending(), false);
    });
  });

  describe("nothingScheduled", () => {
    it("should never be pending", () => {
      assert.strictEqual(nothingScheduled.pending(), false);
    });
  });

  describe("assertNoReentrancy", () => {
    it("should call the function", () => {
      let calls = 0;

      const fn = assertNoReentrancy(() => {
        calls += 1;
      });

      fn();
      fn();

      assert.strictEqual(calls, 2);
    });

    it("should throw if the function is called again while it runs", () => {
      let reentryError: unknown = undefined;

      const fn: () => void = assertNoReentrancy(() => {
        try {
          fn();
        } catch (ex) {
          reentryError = ex;
        }
      });

      fn();

      assert.deepStrictEqual(reentryError, Error("reentered"));
    });

    it("should allow calls again after the function threw", () => {
      let shouldThrow = true;

      const fn = assertNoReentrancy(() => {
        if (shouldThrow) {
          throw Error("failed");
        }
      });

      assert.throws(fn, /failed/);

      shouldThrow = false;
      fn();
    });
  });
});

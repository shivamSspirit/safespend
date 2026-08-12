import assert from "node:assert/strict";
import test from "node:test";
import { retryOnce } from "./retry";

test("retries one transient failure", async () => {
  let attempts = 0;
  const result = await retryOnce(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient");
    return "healthy";
  }, 0);

  assert.equal(result, "healthy");
  assert.equal(attempts, 2);
});

test("propagates the second failure", async () => {
  let attempts = 0;
  await assert.rejects(
    retryOnce(async () => {
      attempts += 1;
      throw new Error(`failure ${attempts}`);
    }, 0),
    /failure 2/,
  );
  assert.equal(attempts, 2);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { batches, callBatches } from "#src/batches.ts";

test("call production and results are bounded before a consumer commits its first batch", async () => {
  let produced = 0;
  function* fresh() { for (let i = 0; i < 1_000_000; i++) { produced++; yield i; } }
  const pending = callBatches(fresh(), [], String, () => false);
  assert.deepEqual((await pending.next()).value, Array.from({ length: 100 }, (_, i) => i));
  assert.equal(produced, 100, "does not build all calls or request the next batch early");
  await pending.return(undefined);
  assert.equal(produced, 100);
  assert.throws(() => [...batches([1], 0)], /positive integer/);
});

test("retries stream page by page, preserving old blocks and dropping current-call twins", async () => {
  let pagesRead = 0;
  async function* pages() { pagesRead++; yield [2, 4, 4]; pagesRead++; yield [5]; }
  const pending = callBatches([1, 2], [1, 3, 3], String, (n) => n <= 2, { retryPages: pages() }, 2);
  assert.deepEqual((await pending.next()).value, [1, 2]);
  assert.equal(pagesRead, 0);
  assert.deepEqual((await pending.next()).value, [3, 4]);
  assert.equal(pagesRead, 1);
  assert.deepEqual((await pending.next()).value, [5]);
  assert.equal(pagesRead, 2);
  assert.equal((await pending.next()).done, true);
});

test("historical API retries can run first without buffering the fresh history", async () => {
  const seen = [];
  for await (const part of callBatches([3, 4], [1, 3], String, (n) => n >= 3, undefined, 2, true)) seen.push(...part);
  assert.deepEqual(seen, [1, 3, 4]);
});

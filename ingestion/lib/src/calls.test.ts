import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, settleCalls } from "#src/calls.ts";

test("an AggregateError without a message is described by the errors inside it", () => {
  const refused = new AggregateError([
    new Error("connect ECONNREFUSED ::1:5432"),
    new Error("connect ECONNREFUSED 127.0.0.1:5432"),
  ]);
  assert.equal(describeError(refused), "connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432");
});

// A large input must not start every RPC at once; each chunk still starts in one tick for batching.
test("settleCalls bounds active reads while preserving same-tick RPC batches", async () => {
  let active = 0;
  let peak = 0;
  const tickSizes: number[] = [];
  let tick = 0;
  const calls = Array.from({ length: 250 }, (_, i) => i);
  const batch = await settleCalls(calls, String, async (call) => {
    active++;
    peak = Math.max(peak, active);
    tick++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (tick) {
      tickSizes.push(tick);
      tick = 0;
    }
    active--;
    return { call };
  });
  assert.equal(peak, 100);
  assert.deepEqual(tickSizes, [100, 100, 50]);
  assert.deepEqual(batch.records.map((record) => record.data.call), calls);
  assert.deepEqual(batch.failed, []);
});

test("settleCalls keeps last duplicates, row ids and failure order across chunks", async () => {
  const calls = Array.from({ length: 205 }, (_, id) => ({ id, value: id }));
  calls.push({ id: 1, value: 999 });
  const seen: number[] = [];
  const batch = await settleCalls(
    calls,
    (call) => String(call.id),
    async (call) => {
      seen.push(call.id);
      if (call.id === 2 || call.id === 102) throw new Error(`failed ${call.id}`);
      return { value: call.value, slot: 7 };
    },
    (call, data) => `${data.slot}:${call.id}`,
  );
  assert.equal(seen.length, 205);
  assert.deepEqual(batch.records.slice(0, 2), [
    { id: "7:0", callId: "0", data: { value: 0, slot: 7 } },
    { id: "7:1", callId: "1", data: { value: 999, slot: 7 } },
  ]);
  assert.equal(batch.records.at(-1)!.id, "7:204");
  assert.deepEqual(batch.failed, [
    { id: "2", call: { id: 2, value: 2 }, error: "failed 2" },
    { id: "102", call: { id: 102, value: 102 }, error: "failed 102" },
  ]);
});

test("settleCalls makes no reads for empty input", async () => {
  const batch = await settleCalls([], String, async () => {
    throw new Error("unexpected read");
  });
  assert.deepEqual(batch, { records: [], failed: [] });
});

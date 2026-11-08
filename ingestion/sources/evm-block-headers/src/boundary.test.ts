import assert from "node:assert/strict";
import { test } from "node:test";
import { firstBlockAtOrAfter, MAX_MIDNIGHTS, midnights } from "#src/boundary.ts";

const at = (iso: string) => new Date(iso);

test("every midnight from START_DATE to END_DATE that the head has passed, as ISO strings", () => {
  assert.deepEqual(midnights("2026-11-04", undefined, at("2026-11-06T12:00:00Z")), [
    "2026-11-04T00:00:00.000Z",
    "2026-11-05T00:00:00.000Z",
    "2026-11-06T00:00:00.000Z",
  ]);
  assert.deepEqual(
    midnights("2026-11-04", "2026-11-05", at("2026-11-06T12:00:00Z")),
    ["2026-11-04T00:00:00.000Z", "2026-11-05T00:00:00.000Z"],
    "END_DATE stops it short of the head",
  );
  assert.deepEqual(
    midnights("2026-11-04", "2026-11-09", at("2026-11-05T23:59:59Z")),
    ["2026-11-04T00:00:00.000Z", "2026-11-05T00:00:00.000Z"],
    "a midnight the head has not reached is left out, END_DATE or not",
  );
  assert.deepEqual(midnights("2026-11-06", undefined, at("2026-11-06T00:00:00Z")), ["2026-11-06T00:00:00.000Z"], "a head right at midnight has reached it");
  assert.deepEqual(midnights("2026-11-07", undefined, at("2026-11-06T23:59:59Z")), [], "nothing before START_DATE's midnight");
});

test(`a run reads at most ${MAX_MIDNIGHTS} midnights, and more fails it`, () => {
  const head = at("2026-11-06T12:00:00Z");
  assert.equal(midnights("2024-02-11", undefined, head).length, MAX_MIDNIGHTS);
  assert.throws(() => midnights("2024-02-10", undefined, head), /2024-02-10 to 2026-11-06 holds 1001 midnights, more than the 1000 a run reads: set END_DATE/);
});

// Blocks 0 to 199, about 12 s apart, with runs of equal timestamps and a long gap, as real chains have.
const timestamps = Array.from({ length: 200 }, (_, n) => 1_000 + 12 * n + (n >= 50 && n < 54 ? 12 * (54 - n) : 0) + (n >= 120 ? 3_600 : 0));
const head = timestamps.length - 1;
const linear = (time: number) => {
  const found = timestamps.findIndex((t) => t >= time);
  return found === -1 ? head + 1 : found;
};

test("the search finds the first block at or after a time from any guess, as a scan of every block does", async () => {
  const times = [0, 1_000, 1_001, 1_011, 1_012, 1_600, 1_648, 2_000, 2_428, 2_429, 3_000, 5_000, 6_028, 6_029, 9_999];
  const guesses = [-5, 0, 1, 37, 53, 54, 99, 119, 120, 121, 150, head, head + 40];
  for (const time of times) {
    for (const guess of guesses) {
      let reads = 0;
      const found = await firstBlockAtOrAfter(time, guess, head, async (n) => {
        reads += 1;
        assert(n >= 0 && n <= head, `read block ${n}, outside the chain`);
        return timestamps[n]!;
      });
      assert.equal(found, linear(time), `time ${time}, guess ${guess}`);
      assert(reads <= 2 * Math.ceil(Math.log2(head + 1)) + 2, `time ${time}, guess ${guess}: ${reads} reads`);
    }
  }
});

test("an exact guess costs two header reads: the block and the one before it", async () => {
  const read: number[] = [];
  const found = await firstBlockAtOrAfter(timestamps[80]!, 80, head, async (n) => {
    read.push(n);
    return timestamps[n]!;
  });
  assert.equal(found, 80);
  assert.deepEqual(read, [80, 79]);
});

test("a search that reads more headers than its bound fails instead of looping", async () => {
  const rising = async (n: number) => n;
  await assert.rejects(firstBlockAtOrAfter(2 ** 40, 0, 2 ** 50, rising), /read more than 64 headers/);
});

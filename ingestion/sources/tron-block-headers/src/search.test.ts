import assert from "node:assert/strict";
import { test } from "node:test";
import { firstBlockAtOrAfter } from "#src/search.ts";

// A chain of 3-second blocks from 1,000 s with a missed slot after every seventh block, so block
// times are uneven, as on TRON.
const HEAD = 5_000;
const TIMESTAMPS_MS = Array.from(
  { length: HEAD + 1 },
  (_, n) => (1_000 + n * 3 + Math.floor(n / 7) * 3) * 1000,
);

function chain() {
  const probes: number[] = [];
  const timestampOf = async (block: number) => {
    assert.ok(block >= 0 && block <= HEAD, `probed block ${block}, outside the chain`);
    probes.push(block);
    return TIMESTAMPS_MS[block]!;
  };
  return { probes, timestampOf };
}

/** The answer by reading every block in order. */
const scan = (timeMs: number) => {
  const found = TIMESTAMPS_MS.findIndex((timestampMs) => timestampMs >= timeMs);
  return found === -1 ? HEAD + 1 : found;
};

test("the first block at or after a time matches a full scan, whatever the guess", async () => {
  const last = TIMESTAMPS_MS[HEAD]!;
  const times = [0, 1_000_000, 1_001_000, 4_200_500, 4_201_000, 9_000_000, last, last + 1, 1e13];
  const guesses = [0, 1, 700, 1_399, 1_400, 4_999, HEAD, HEAD + 50, -3];
  for (const timeMs of times) {
    for (const guess of guesses) {
      const { timestampOf } = chain();
      const found = await firstBlockAtOrAfter(timeMs, guess, HEAD, timestampOf);
      assert.equal(found, scan(timeMs), `time ${timeMs}, guess ${guess}`);
    }
  }
});

test("a guess 895 blocks early, as on 2026-11-06, takes about 2 log2(895) probes", async () => {
  const target = 3_000;
  const timeMs = TIMESTAMPS_MS[target]!;
  const { probes, timestampOf } = chain();
  assert.equal(await firstBlockAtOrAfter(timeMs, target - 895, HEAD, timestampOf), target);
  assert.ok(probes.length <= 24, `${probes.length} probes`);
});

test("a time between two blocks gives the later block", async () => {
  const { timestampOf } = chain();
  const between = (TIMESTAMPS_MS[41]! + TIMESTAMPS_MS[42]!) / 2;
  assert.equal(await firstBlockAtOrAfter(between, 0, HEAD, timestampOf), 42);
});

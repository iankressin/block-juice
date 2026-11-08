import assert from "node:assert/strict";

/** A block's timestamp in milliseconds, by its number. Timestamps never fall along the chain. */
export type TimestampOf = (block: number) => Promise<number>;

// Doubling steps reach any block below 2^64 well within this many probes, and so does bisection.
const STEPS_MAX = 64;

/**
 * Blocks low and high with low <= the first block at or after `timeMs` <= high, found by stepping
 * away from `guess` in steps that double. [head + 1, head + 1] when every block is earlier.
 */
async function around(
  timeMs: number,
  guess: number,
  head: number,
  timestampOf: TimestampOf,
): Promise<[number, number]> {
  let step = 1;
  if ((await timestampOf(guess)) >= timeMs) {
    let high = guess;
    for (let i = 0; i < STEPS_MAX && high > 0; i++) {
      const probe = Math.max(guess - step, 0);
      if ((await timestampOf(probe)) < timeMs) return [probe + 1, high];
      high = probe;
      step *= 2;
    }
    assert.equal(high, 0, "doubling steps reach block 0 within STEPS_MAX");
    return [0, 0];
  }
  let low = guess + 1;
  for (let i = 0; i < STEPS_MAX && low <= head; i++) {
    const probe = Math.min(guess + step, head);
    if ((await timestampOf(probe)) >= timeMs) return [low, probe];
    low = probe + 1;
    step *= 2;
  }
  assert.equal(low, head + 1, "doubling steps reach the head within STEPS_MAX");
  return [head + 1, head + 1];
}

/**
 * The first block whose timestamp is at or after `timeMs`, or head + 1 when every block is earlier.
 * It brackets that block by stepping away from `guess`, then bisects the bracket.
 */
export async function firstBlockAtOrAfter(
  timeMs: number,
  guess: number,
  head: number,
  timestampOf: TimestampOf,
): Promise<number> {
  assert.ok(Number.isSafeInteger(timeMs), `bad time ${timeMs}`);
  assert.ok(Number.isSafeInteger(head), `bad head ${head}`);
  assert.ok(head >= 0, `bad head ${head}`);
  assert.ok(Number.isSafeInteger(guess), `bad guess ${guess}`);
  let [low, high] = await around(timeMs, Math.min(Math.max(guess, 0), head), head, timestampOf);
  assert.ok(low <= high);
  for (let i = 0; i < STEPS_MAX && low < high; i++) {
    const middle = Math.floor((low + high) / 2);
    if ((await timestampOf(middle)) >= timeMs) high = middle;
    else low = middle + 1;
  }
  assert.equal(low, high, "bisection ends within STEPS_MAX");
  assert.ok(low >= 0);
  assert.ok(low <= head + 1);
  return low;
}

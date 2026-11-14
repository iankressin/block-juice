import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_MS, historyKey, historyPlan, historyState } from "#src/history.ts";

test("history resumes interrupted sweeps, overlaps recent data and periodically revisits old corrections", () => {
  const origin = Date.UTC(2026, 0, 1), now = origin + 100 * DAY_MS;
  const first = historyPlan("k", origin, DAY_MS, now, undefined);
  assert.equal(first.from, origin);
  const saved = historyState(first.checkpoint(origin + 40 * DAY_MS).value)!;
  assert.equal(historyPlan("k", origin, DAY_MS, now, saved).from, origin + 40 * DAY_MS);
  const done = historyState(first.checkpoint(now + DAY_MS).value)!;
  assert.equal(historyPlan("k", origin, DAY_MS, now + DAY_MS, done).from, now - 2 * DAY_MS);
  assert.equal(historyPlan("k", origin, DAY_MS, now + 8 * DAY_MS, done).from, origin);
  assert.equal(historyPlan("k", origin, DAY_MS, now, done, { HISTORY_FULL_REFRESH: "1" }).from, origin);
  assert.notEqual(historyKey(["endpoint", "token-a", origin]), historyKey(["endpoint", "token-b", origin]));
});

test("a closed window is revisited if its final candle was still open on the previous run", () => {
  const span = 10 * DAY_MS;
  const beforeClose = span - 1;
  const afterOutage = span + 5 * DAY_MS;
  const legacy = { origin: 0, next: span, refreshedAt: beforeClose };
  const first = historyPlan("k", 0, span, beforeClose, undefined);
  const saved = historyState(first.checkpoint(span).value)!;
  for (const checkpoint of [legacy, saved]) {
    for (const overlap of [0, 1]) {
      const settings = { HISTORY_OVERLAP_DAYS: overlap };
      const resumed = historyPlan("k", 0, span, afterOutage, checkpoint, settings);
      assert.equal(resumed.from, 0);
      const caughtUp = historyState(resumed.checkpoint(2 * span).value)!;
      assert.equal(historyPlan("k", 0, span, afterOutage, caughtUp, settings).from, span);
    }
  }
});

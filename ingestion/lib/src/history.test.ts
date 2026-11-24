import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_MS, historyEnv, historyKey, historyPlan, historyState } from "#src/history.ts";

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

test("windows walk from the plan's start to now and covers accepts only those windows", () => {
  const span = 10 * DAY_MS, now = 35 * DAY_MS;
  const plan = historyPlan("k", 0, span, now, undefined);
  assert.deepEqual([...plan.windows()], [0, span, 2 * span, 3 * span]);
  assert.equal(plan.covers(span, 2 * span - 1), true);
  assert.equal(plan.covers(3 * span, 4 * span - 1), true);
  assert.equal(plan.covers(span, 2 * span), false, "end off by one");
  assert.equal(plan.covers(span + 1, 2 * span), false, "start off the grid");
  assert.equal(plan.covers(4 * span, 5 * span - 1), false, "start after now");
  assert.deepEqual([...historyPlan("k", 0, span, 3 * span, undefined).windows()], [0, span, 2 * span, 3 * span], "a start at now counts");
  const resumed = historyPlan("k", 0, span, now, { origin: 0, next: 3 * span, refreshedAt: now }, { HISTORY_OVERLAP_DAYS: 0 });
  assert.equal(resumed.covers(span, 2 * span - 1), false, "start before from");
});

test("historyEnv parses a date or datetime and refuses other text", () => {
  const parse = (START_TIME?: string) => historyEnv.safeParse({ START_TIME });
  assert.equal(parse("2026-10-01").data?.START_TIME, Date.UTC(2026, 9, 1));
  assert.equal(parse("2026-10-01T00:00:00Z").data?.START_TIME, Date.UTC(2026, 9, 1));
  const bad = parse("last week");
  assert.equal(bad.success, false);
  assert.match(bad.error!.issues[0]!.message, /Expected an ISO date or datetime/);
  assert.equal(parse(undefined).error!.issues[0]!.message, "Required");
});

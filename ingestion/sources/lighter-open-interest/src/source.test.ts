import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock, RawRecord } from "@ingestion/lib";
import { fakeBucket, parquetFile } from "@ingestion/lib/lighter/s3-fixture";
import { openInterestSource } from "#src/source.ts";

const clock: Clock = { now: () => Date.parse("2026-11-17T08:00:00Z"), sleep: async () => {} };

test("loads a day's open interest, keyed by symbol and hour, as Lighter sent it", async (t) => {
  const file = await parquetFile(
    t,
    `select * from (values
      (TIMESTAMPTZ '2026-11-14 22:00:00+00', 'ETH', 100.5, 3000.25, 301525.125),
      (TIMESTAMPTZ '2026-11-14 22:00:00+00', 'BTC', 10.0, 90000.0, 900000.0),
      (TIMESTAMPTZ '2026-11-14 23:00:00+00', 'ETH', 101.5, 3001.0, 304601.5),
      (TIMESTAMPTZ '2026-11-14 23:00:00+00', 'BTC', 11.0, 90100.0, 991100.0)
    ) t(hour, symbol, open_interest, mark_price, open_interest_usd)`,
  );
  const bucket = await fakeBucket(t, "open_interest_hourly", { "2026-11-14": file });
  const source = openInterestSource(clock);
  const env = source.env.parse({ ...bucket.env, START_DATE: "2026-11-14" });

  const records: RawRecord[] = [];
  for await (const batch of source.extract(env, [])) records.push(...batch.records);

  assert.deepEqual(records.map((r) => r.id), [
    "ETH:2026-11-14 22:00:00+00",
    "BTC:2026-11-14 22:00:00+00",
    "ETH:2026-11-14 23:00:00+00",
    "BTC:2026-11-14 23:00:00+00",
  ]);
  assert.deepEqual(records[2]!.data, {
    hour: "2026-11-14 23:00:00+00",
    symbol: "ETH",
    open_interest: "101.5",
    mark_price: "3001.00",
    open_interest_usd: "304601.500",
  });
});

test("END_DATE may not precede START_DATE", () => {
  const { env } = openInterestSource();
  assert.throws(() => env.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-13" }), /END_DATE may not come before START_DATE/);
  assert.doesNotThrow(() => env.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-14" }));
});

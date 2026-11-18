import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import { lighterExplorerEnv, type Clock } from "@ingestion/lib/lighter";
import { txStatsSource } from "#src/source.ts";

type Call = { kind: "tx_stats" };

const HOUR = 3600;
const FIRST = 1759363200; // 2025-10-02 00:00 UTC
const TYPES = ["timestamp", "count", "uopsCount"];

const chart = (data: unknown[], types: unknown = TYPES) => ({ data: { chart: { types, data } } });

/** The Explorer's stats/tx on a local port. `requests` gets each path with its query. */
async function fakeExplorer(t: TestContext, body: unknown) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A clock stopped at `seconds` that a sleep moves forward at once. */
function clockAt(seconds: number): Clock {
  let now = seconds * 1000;
  return { now: () => now, sleep: async (ms) => void (now += ms) };
}

async function run(url: string, nowSeconds: number) {
  const env = lighterExplorerEnv.parse({ LIGHTER_EXPLORER_URL: url, LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: 45 });
  const batches: Batch<Call>[] = [];
  for await (const batch of txStatsSource(clockAt(nowSeconds)).extract(env, [])) batches.push(batch);
  return batches;
}

const ids = (batches: Batch<Call>[]) => batches.flatMap((b) => b.records.map((r) => r.id));

test("writes one record per hour, keyed by its timestamp", async (t) => {
  const { url, requests } = await fakeExplorer(
    t,
    chart([
      [FIRST, 3571651, 3571652],
      [FIRST + HOUR, 3500000, 3500001],
    ]),
  );

  const batches = await run(url, FIRST + 3 * HOUR);

  assert.deepEqual(requests, ["/api/stats/tx?aggregation_period=1h"]);
  const records = batches.flatMap((b) => b.records);
  assert.deepEqual(ids(batches), [String(FIRST), String(FIRST + HOUR)]);
  assert.deepEqual(records[0]!.data, { types: TYPES, point: [FIRST, 3571651, 3571652] });
  assert.equal(records[0]!.callId, "tx_stats");
  assert.deepEqual(batches.flatMap((b) => b.failed), []);
  assert.deepEqual(batches.flatMap((b) => b.succeededCallIds ?? []), ["tx_stats"]);
});

test("the current hour waits for the next run", async (t) => {
  const { url } = await fakeExplorer(
    t,
    chart([
      [FIRST, 1, 1],
      [FIRST + HOUR, 2, 2],
      [FIRST + 2 * HOUR, 3, 3],
    ]),
  );

  // 10 minutes into the third hour: the third point is open.
  assert.deepEqual(ids(await run(url, FIRST + 2 * HOUR + 600)), [String(FIRST), String(FIRST + HOUR)]);
  // At the first second of the third hour the second hour has just closed.
  assert.deepEqual(ids(await run(url, FIRST + 2 * HOUR)), [String(FIRST), String(FIRST + HOUR)]);
  // One second before the second hour ends it is still open.
  assert.deepEqual(ids(await run(url, FIRST + 2 * HOUR - 1)), [String(FIRST)]);
  // An hour after the third point's start it is closed.
  assert.equal(ids(await run(url, FIRST + 3 * HOUR)).length, 3);
});

test("a changed types list fails the call, naming it", async (t) => {
  const { url } = await fakeExplorer(t, chart([[FIRST, 1, 1, 1]], ["timestamp", "count", "uopsCount", "extra"]));

  const batches = await run(url, FIRST + 3 * HOUR);

  assert.deepEqual(ids(batches), []);
  const failed = batches.flatMap((b) => b.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.id, "tx_stats");
  assert.deepEqual(failed[0]!.call, { kind: "tx_stats" });
  assert.match(failed[0]!.error, /types/);
  assert.match(failed[0]!.error, /timestamp.*count.*uopsCount/);
});

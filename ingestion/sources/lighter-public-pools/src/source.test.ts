import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch, Clock } from "@ingestion/lib";
import { lighterEnv } from "@ingestion/lib/lighter";
import { publicPoolsSource } from "#src/source.ts";

const NOW = 1794918000000;
const TOP = 281474976710655;

type Call = { kind: "public_pools" };

const pool = (account_index: number) => ({ account_index, name: `pool ${account_index}`, account_type: 2 });

/** `count` pools below `top`, highest first. */
const pools = (top: number, count: number) => Array.from({ length: count }, (_, i) => pool(top - 1 - i));

/**
 * Lighter's publicPoolsMetadata on a local port. Like the real one, it lists pools below `index`:
 * `pages` maps each index asked to the pools it answers, and an index not in `pages`, or the
 * `failIndex`, answers 500.
 */
async function fakeLighter(t: TestContext, pages: Map<number, unknown[]>, failIndex?: number) {
  const requests: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    const query = new URL(req.url!, "http://x").searchParams;
    requests.push(query);
    const index = Number(query.get("index"));
    const known = pages.get(index);
    if (known === undefined || index === failIndex) {
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ code: 500, message: "down" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: 200, public_pools: known }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A clock stopped at NOW that a sleep moves forward at once. */
function fakeClock(): Clock {
  let now = NOW;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

async function run(url: string, retry: Call[] = []) {
  const env = lighterEnv.parse({ LIGHTER_API_URL: url });
  const batches: Batch<Call>[] = [];
  for await (const batch of publicPoolsSource(fakeClock()).extract(env, retry)) batches.push(batch);
  return batches;
}

test("walks pages down from the top index until a short page", async (t) => {
  const first = pools(TOP, 100);
  const lastOfFirst = first[99]!.account_index;
  const second = pools(lastOfFirst, 37);
  const { url, requests } = await fakeLighter(
    t,
    new Map([
      [TOP, first],
      [lastOfFirst, second],
    ]),
  );
  const batches = await run(url);
  // The cursor is exclusive, so the next page asks from the last account_index it got, with no - 1.
  assert.deepEqual(
    requests.map((q) => Number(q.get("index"))),
    [TOP, lastOfFirst],
  );
  assert.deepEqual(
    requests.map((q) => [q.get("filter"), q.get("limit")]),
    [
      ["all", "100"],
      ["all", "100"],
    ],
  );
  const records = batches.flatMap((b) => b.records);
  assert.equal(records.length, 137);
  assert.equal(records[0]!.id, `${TOP - 1}:${NOW}`);
  assert.equal(records[0]!.data.read_at, NOW);
  assert.equal((records[0]!.data.pool as { account_index: number }).account_index, TOP - 1);
  assert.equal(new Set(records.map((r) => r.id)).size, 137);
  // Only the last page's records carry the call id.
  assert.deepEqual([...new Set(records.slice(0, 100).map((r) => r.callId))], ["public_pools#0"]);
  assert.deepEqual([...new Set(records.slice(100).map((r) => r.callId))], ["public_pools"]);
  assert.deepEqual(batches.flatMap((b) => b.failed), []);
  assert.deepEqual(batches.flatMap((b) => b.succeededCallIds ?? []), ["public_pools"]);
});

test("a failed page fails the walk, and pages before it stay", async (t) => {
  const first = pools(TOP, 100);
  const lastOfFirst = first[99]!.account_index;
  const { url } = await fakeLighter(t, new Map([[TOP, first], [lastOfFirst, []]]), lastOfFirst);
  const batches = await run(url);
  const records = batches.flatMap((b) => b.records);
  assert.equal(records.length, 100);
  assert.ok(records.every((r) => r.callId === "public_pools#0"));
  const failed = batches.flatMap((b) => b.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.id, "public_pools");
  assert.deepEqual(failed[0]!.call, { kind: "public_pools" });
  assert.deepEqual(batches.flatMap((b) => b.succeededCallIds ?? []), []);
});

test("a page that does not move below the index asked fails the walk", async (t) => {
  // An API that ignored the cursor would send the same full page for ever.
  const stuck = pools(TOP, 100).map((p, i) => ({ ...p, account_index: TOP + 1 + i }));
  const { url, requests } = await fakeLighter(t, new Map([[TOP, stuck]]));
  const batches = await run(url);
  assert.equal(requests.length, 1);
  assert.equal(batches.flatMap((b) => b.records).length, 0);
  assert.match(batches.flatMap((b) => b.failed)[0]!.error, /below/);
});

test("a walk with no pools still clears the call's dead letter", async (t) => {
  const { url } = await fakeLighter(t, new Map([[TOP, []]]));
  const batches = await run(url, [{ kind: "public_pools" }]);
  assert.deepEqual(batches.flatMap((b) => b.records), []);
  assert.deepEqual(batches.flatMap((b) => b.succeededCallIds ?? []), ["public_pools"]);
});

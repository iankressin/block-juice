import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import { lighterEnv, type Clock } from "@ingestion/lib/lighter";
import { assetsSource } from "#src/source.ts";

const NOW = 1794918000000;

type Call = { kind: "asset_details" };

const asset = (asset_id: number, symbol: string, decimals: number) => ({ asset_id, symbol, decimals, l1_decimals: decimals });

const DETAILS = { code: 200, asset_details: [asset(3, "USDC", 6), asset(1, "ETH", 8)] };

/** Lighter's assetDetails on a local port. `status` answers every request. */
async function fakeLighter(t: TestContext, status = 200, details: typeof DETAILS = DETAILS) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const body = status === 200 ? details : { code: status, message: "down" };
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
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
  for await (const batch of assetsSource(fakeClock()).extract(env, retry)) batches.push(batch);
  return batches;
}

test("each run reads every asset once, keyed by asset and read time", async (t) => {
  const { url, requests } = await fakeLighter(t);
  // A retried read is the run's own read, so it goes out once.
  const [batch] = await run(url, [{ kind: "asset_details" }]);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /^\/api\/v1\/assetDetails/);
  assert.deepEqual(
    batch!.records.map((r) => r.id),
    ["3:1794918000000", "1:1794918000000"],
  );
  assert.equal(batch!.records[0]!.callId, "asset_details");
  assert.equal(batch!.records[0]!.data.read_at, NOW);
  assert.equal((batch!.records[0]!.data.asset as { symbol: string }).symbol, "USDC");
  assert.deepEqual(batch!.failed, []);
});

test("a failed read waits as a dead letter", async (t) => {
  const { url } = await fakeLighter(t, 500);
  const [batch] = await run(url);
  assert.equal(batch!.records.length, 0);
  assert.equal(batch!.failed[0]!.id, "asset_details");
  assert.deepEqual(batch!.failed[0]!.call, { kind: "asset_details" });
});

test("a successful read with no assets still clears the call's dead letter", async (t) => {
  const { url } = await fakeLighter(t, 200, { code: 200, asset_details: [] });
  const batches = await run(url);
  assert.deepEqual(batches.flatMap((b) => b.records), []);
  assert.deepEqual(batches.flatMap((b) => b.succeededCallIds ?? []), ["asset_details"]);
});

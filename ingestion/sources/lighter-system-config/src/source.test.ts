import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch, Clock } from "@ingestion/lib";
import { lighterEnv } from "@ingestion/lib/lighter";
import { systemConfigSource } from "#src/source.ts";

const NOW = 1794918000000;

type Call = { kind: "system_config" };

// The reply of 2026-11-17 (catalog/vendors/lighter/NOTES.md, Reference endpoints).
const CONFIG = {
  code: 200,
  liquidity_pool_index: 281474976710654,
  staking_pool_index: 281474976624800,
  funding_fee_rebate_account_index: 713888,
  market_maker_incentive_account_index: 723106,
  fee_collector_account_index: 281474976496476,
  liquidity_pool_cooldown_period: 300000,
};

/** Lighter's systemConfig on a local port. `status` answers every request. */
async function fakeLighter(t: TestContext, status = 200) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const body = status === 200 ? CONFIG : { code: status, message: "down" };
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
  for await (const batch of systemConfigSource(fakeClock()).extract(env, retry)) batches.push(batch);
  return batches;
}

test("each run writes one reading", async (t) => {
  const { url, requests } = await fakeLighter(t);
  // A retried read is the run's own read, so it goes out once.
  const [batch] = await run(url, [{ kind: "system_config" }]);
  assert.equal(requests.length, 1);
  assert.match(requests[0]!, /^\/api\/v1\/systemConfig/);
  assert.equal(batch!.records.length, 1);
  const record = batch!.records[0]!;
  assert.equal(record.id, "1794918000000");
  assert.equal(record.callId, "system_config");
  assert.equal(record.data.read_at, NOW);
  const config = record.data.config as Record<string, unknown>;
  assert.equal(config.liquidity_pool_index, 281474976710654);
  assert.equal(config.fee_collector_account_index, 281474976496476);
  assert.deepEqual(batch!.failed, []);
});

test("a failed read waits as a dead letter", async (t) => {
  const { url } = await fakeLighter(t, 500);
  const [batch] = await run(url);
  assert.equal(batch!.records.length, 0);
  assert.equal(batch!.failed[0]!.id, "system_config");
  assert.deepEqual(batch!.failed[0]!.call, { kind: "system_config" });
});

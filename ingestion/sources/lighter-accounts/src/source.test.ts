import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import { lighterEnv, type Clock } from "@ingestion/lib/lighter";
import { accountsSource, type AccountsCall } from "#src/source.ts";

const NOW = Date.parse("2026-11-17T12:16:53Z");

// 313004's account reply as Lighter sent it on 2026-11-17 (catalog/vendors/lighter/NOTES.md, Snapshots).
const account = (index: number) => ({
  index,
  l1_address: "0x3a17bDE82706aaF297A0d721D5c31E4EB3c48B65",
  account_type: 0,
  status: 1,
  collateral: "97972.003001",
  available_balance: "97972.003001",
  total_asset_value: "97971.578287",
  transaction_time: 1794917810524549,
  positions: [
    { market_id: 0, symbol: "ETH", sign: -1, position: "1.2821", unrealized_pnl: "-0.424714" },
    { market_id: 1, symbol: "BTC", sign: 1, position: "0.00000", unrealized_pnl: "0.000000" },
  ],
  assets: [{ symbol: "USDC", asset_id: 3, balance: "97972.003001669667", margin_balance: "97972.003001669667" }],
  shares: [],
  pending_unlocks: [],
});

type Reply = { status: number; body: unknown };

/** Lighter's account and accountsByL1Address on a local port. Indexes in `unknown` answer 29404. */
async function fakeLighter(
  t: TestContext,
  { unknown = [], subAccounts = {} }: { unknown?: number[]; subAccounts?: Record<string, number[]> } = {},
) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const url = new URL(req.url!, "http://lighter");
    let answer: Reply;
    if (url.pathname === "/api/v1/account") {
      const index = Number(url.searchParams.get("value"));
      answer = unknown.includes(index)
        ? { status: 400, body: { code: 29404, message: "not found" } }
        : { status: 200, body: { code: 200, total: 1, accounts: [account(index)] } };
    } else if (url.pathname === "/api/v1/accountsByL1Address") {
      const address = url.searchParams.get("l1_address")!;
      const indexes = subAccounts[address];
      answer = indexes
        ? { status: 200, body: { code: 200, l1_address: address, sub_accounts: indexes.map((index) => ({ index })) } }
        : { status: 400, body: { code: 21100, message: "account not found" } };
    } else {
      answer = { status: 404, body: { error: "not found" } };
    }
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
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
  return { now: () => now, sleep: async (ms) => void (now += ms) };
}

/** Runs the rest of the test from a folder whose addresses.json holds `addresses`, as a source runs from its package. */
async function addressesHold(t: TestContext, addresses: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "lighter-accounts-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), JSON.stringify(addresses));
  process.chdir(dir);
}

async function run(url: string, retry: AccountsCall[] = []) {
  const env = lighterEnv.parse({ LIGHTER_API_URL: url, LIGHTER_REQUESTS_PER_MINUTE: "60" });
  const batches: Batch<AccountsCall>[] = [];
  for await (const batch of accountsSource(fakeClock()).extract(env, retry)) batches.push(batch);
  return batches;
}

test("each run reads every listed account once, keyed by account and read time", async (t) => {
  await addressesHold(t, { accounts: [313004, 693073] });
  const { url, requests } = await fakeLighter(t);
  const batches = await run(url);
  const records = batches.flatMap((b) => b.records);
  assert.deepEqual(records.map((r) => r.id), [`313004:${NOW}`, `693073:${NOW}`]);
  assert.deepEqual(records.map((r) => r.callId), ["account:313004", "account:693073"]);
  assert.deepEqual(records[0]!.data, { read_at: NOW, account: account(313004) });
  assert.deepEqual(batches.flatMap((b) => b.failed), []);
  assert.deepEqual(requests, ["/api/v1/account?by=index&value=313004", "/api/v1/account?by=index&value=693073"]);
});

test("a retried read is made once, by the run's own call", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const { url, requests } = await fakeLighter(t);
  const batches = await run(url, [{ kind: "account", account_index: 313004 }]);
  assert.equal(requests.length, 1);
  assert.equal(batches.flatMap((b) => b.records).length, 1);
});

test("an account Lighter does not know waits as a dead letter, quoting 29404", async (t) => {
  await addressesHold(t, { accounts: [313004, 999] });
  const { url } = await fakeLighter(t, { unknown: [999] });
  const batches = await run(url);
  assert.equal(batches.flatMap((b) => b.records).length, 1);
  const [failed] = batches.flatMap((b) => b.failed);
  assert.equal(failed!.id, "account:999");
  assert.deepEqual(failed!.call, { kind: "account", account_index: 999 });
  assert.match(failed!.error, /29404/);
});

test("an L1 address reads each of its sub-accounts", async (t) => {
  const address = "0x2222222222222222222222222222222222222222";
  await addressesHold(t, { accounts: [313004], l1_addresses: [address] });
  const { url, requests } = await fakeLighter(t, { subAccounts: { [address]: [700002, 700001] } });
  const batches = await run(url);
  assert.deepEqual(batches.flatMap((b) => b.records).map((r) => r.id), [`313004:${NOW}`, `700001:${NOW}`, `700002:${NOW}`]);
  assert.equal(requests.filter((r) => r.startsWith("/api/v1/account?")).length, 3);
});

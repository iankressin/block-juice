import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import type { Clock } from "@ingestion/lib/lighter";
import { pnlSource, type PnlCall } from "#src/source.ts";

// 2026-11-17T13:24:32Z, in ms and in seconds.
const NOW = Date.parse("2026-11-17T13:24:32Z");
const NOW_S = NOW / 1000;
const START_TIME = Date.parse("2026-11-10T00:00:00Z");
const MIDNIGHT = 1794873600; // 2026-11-17T00:00:00Z

// A point as Lighter sends it: JSON numbers (catalog/vendors/lighter/NOTES.md, Account value).
const point = (timestamp: number, inflow = 20006.337415) => ({
  timestamp,
  trade_pnl: 77970.108827,
  trade_spot_pnl: 0,
  inflow,
  outflow: 4.867955,
  spot_inflow: 0,
  spot_outflow: 0,
  pool_pnl: 0,
  pool_inflow: 0,
  pool_outflow: 0,
  staking_pnl: 0,
  staking_inflow: 0,
  staking_outflow: 0,
  pool_total_shares: 0,
  volume: 1234.5,
});

type Reply = { status: number; body: unknown };
type Answers = { "1d"?: (account: number) => Reply; "1h"?: (account: number) => Reply };

const ok = (resolution: string, points: unknown[]): Reply => ({ status: 200, body: { code: 200, resolution, pnl: points } });

/** Lighter's pnl endpoint on a local port, answering each resolution as `answers` says. */
async function fakeLighter(t: TestContext, answers: Answers) {
  const requests: URLSearchParams[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://lighter");
    requests.push(url.searchParams);
    let answer: Reply = { status: 404, body: { error: "not found" } };
    if (url.pathname === "/api/v1/pnl") {
      const make = answers[url.searchParams.get("resolution") as "1d" | "1h"];
      if (make) answer = make(Number(url.searchParams.get("value")));
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
  const dir = await mkdtemp(join(tmpdir(), "lighter-pnl-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), JSON.stringify(addresses));
  process.chdir(dir);
}

async function run(url: string, retry: PnlCall[] = [], startTime = START_TIME) {
  const source = pnlSource(fakeClock());
  const env = source.env.parse({
    LIGHTER_API_URL: url,
    LIGHTER_REQUESTS_PER_MINUTE: "60",
    START_TIME: new Date(startTime).toISOString(),
  });
  const batches: Batch<PnlCall>[] = [];
  for await (const batch of source.extract(env, retry)) batches.push(batch);
  return batches;
}

test("reads each account's 1d series from START_TIME and its last 7 days of 1h", async (t) => {
  await addressesHold(t, { accounts: [313004, 693073] });
  const { url, requests } = await fakeLighter(t, {
    "1d": () => ok("1d", [point(MIDNIGHT - 86400), point(MIDNIGHT)]),
    "1h": () => ok("1h", [point(MIDNIGHT), point(MIDNIGHT + 3600)]),
  });
  const batches = await run(url);
  const query = (value: string, resolution: string, start: string) => ({
    by: "index",
    value,
    resolution,
    start_timestamp: start,
    end_timestamp: String(NOW_S),
    count_back: "0",
  });
  assert.deepEqual(
    requests.map((q) => Object.fromEntries(q)),
    [
      query("313004", "1d", "1794268800"),
      query("313004", "1h", "1794317072"),
      query("693073", "1d", "1794268800"),
      query("693073", "1h", "1794317072"),
    ],
  );
  const records = batches.flatMap((b) => b.records);
  assert.deepEqual(
    records.map((r) => [r.id, r.callId]),
    [
      [`313004:1d:${MIDNIGHT - 86400}`, "pnl:313004:1d"],
      [`313004:1d:${MIDNIGHT}`, "pnl:313004:1d"],
      [`313004:1h:${MIDNIGHT}`, "pnl:313004:1h"],
      [`313004:1h:${MIDNIGHT + 3600}`, "pnl:313004:1h"],
      [`693073:1d:${MIDNIGHT - 86400}`, "pnl:693073:1d"],
      [`693073:1d:${MIDNIGHT}`, "pnl:693073:1d"],
      [`693073:1h:${MIDNIGHT}`, "pnl:693073:1h"],
      [`693073:1h:${MIDNIGHT + 3600}`, "pnl:693073:1h"],
    ],
  );
  // The point is kept as sent, JSON numbers included.
  assert.deepEqual(records[0]!.data, { account_index: 313004, resolution: "1d", point: point(MIDNIGHT - 86400) });
  assert.deepEqual(batches.flatMap((b) => b.failed), []);
});

test("a START_TIME inside the last 7 days starts the 1h series there, and one inside a day floors the 1d start", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const { url, requests } = await fakeLighter(t, { "1d": () => ok("1d", []), "1h": () => ok("1h", []) });
  await run(url, [], Date.parse("2026-11-16T10:30:00Z"));
  assert.equal(requests[0]!.get("start_timestamp"), String(Date.parse("2026-11-16T00:00:00Z") / 1000));
  assert.equal(requests[1]!.get("start_timestamp"), String(Date.parse("2026-11-16T10:30:00Z") / 1000));
});

test("the point at the request time waits for the next run", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const { url } = await fakeLighter(t, {
    // Lighter ends its 1d series with a point at the request time, off the day's boundary.
    "1d": () => ok("1d", [point(MIDNIGHT), point(1794921499)]),
    "1h": () => ok("1h", [point(MIDNIGHT + 3600 * 13), point(1794921499)]),
  });
  const records = (await run(url)).flatMap((b) => b.records);
  assert.deepEqual(
    records.map((r) => r.id),
    [`313004:1d:${MIDNIGHT}`, `313004:1h:${MIDNIGHT + 3600 * 13}`],
  );
});

test("a 22403 for an over-long hourly range fails the call, quoting it", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const { url } = await fakeLighter(t, {
    "1d": () => ok("1d", [point(MIDNIGHT)]),
    "1h": () => ({
      status: 400,
      body: { code: 22403, message: "time range exceeds maximum allowed range for the specified resolution" },
    }),
  });
  const batches = await run(url);
  const [failed] = batches.flatMap((b) => b.failed);
  assert.equal(failed!.id, "pnl:313004:1h");
  assert.deepEqual(failed!.call, { kind: "pnl", account_index: 313004, resolution: "1h" });
  assert.match(failed!.error, /22403/);
});

test("a failed call waits as a dead letter, and the account's other series loads", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const { url } = await fakeLighter(t, {
    "1d": () => ({ status: 400, body: { code: 29404, message: "not found" } }),
    "1h": () => ok("1h", [point(MIDNIGHT)]),
  });
  const batches = await run(url);
  assert.deepEqual(batches.flatMap((b) => b.records).map((r) => r.id), [`313004:1h:${MIDNIGHT}`]);
  assert.deepEqual(batches.flatMap((b) => b.failed).map((f) => f.id), ["pnl:313004:1d"]);
});

test("a retried call is made once, by the run's own call", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const { url, requests } = await fakeLighter(t, { "1d": () => ok("1d", []), "1h": () => ok("1h", []) });
  await run(url, [{ kind: "pnl", account_index: 313004, resolution: "1d" }]);
  assert.equal(requests.length, 2);
});

test("a reply in an unexpected shape fails the call", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const { url } = await fakeLighter(t, {
    "1d": () => ({ status: 200, body: { code: 200, pnl: "nope" } }),
    "1h": () => ok("1h", []),
  });
  const [failed] = (await run(url)).flatMap((b) => b.failed);
  assert.equal(failed!.id, "pnl:313004:1d");
  assert.match(failed!.error, /unexpected shape/);
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { historyKey, type Batch } from "@ingestion/lib";
import { LEDGER_TYPES, type Clock } from "@ingestion/lib/lighter";
import { accountLogsSource, MAX_PAGES_PER_WALK, type AccountLogsCall } from "#src/source.ts";

type Entry = {
  tx_type: string;
  hash: string;
  time: string;
  pubdata: Record<string, unknown>;
  pubdata_type: string;
  status: string | null;
};
type Reply = { status: number; body: unknown };

const MINUTE = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-18T12:00:00Z");
const START = Date.parse("2026-11-16T00:00:00Z");

// Entries of account 693073 as the Explorer sent them on 2026-11-18 (catalog/vendors/lighter/NOTES.md,
// Account logs), newest first, and the block and batch logs/{hash} gave for the two money moves.
const TRADE: Entry = {
  tx_type: "L2CreateOrder",
  hash: "6a3919241165019c60ff51a0502eee532f639ea405777ea0f93440b026b949cbf4aca9f138ae0a70",
  time: "2026-11-16T16:12:08.265Z",
  pubdata: {
    trade_pubdata_with_funding: {
      trade_type: 0, market_index: 1, is_taker_ask: 0, maker_fee: 28, taker_fee: 280, taker_account_index: "693073",
      maker_account_index: "366058", fee_account_index: "0", price: "64299.5", size: "0.00030", funding_rate_prefix_sum: 123593983719,
    },
  },
  pubdata_type: "TradeWithFunding",
  status: "nothing_to_execute",
};
const TRANSFER: Entry = {
  tx_type: "L2Transfer",
  hash: "6b7f2d1e9c96a7c499b11e9fa24f9e808d88926ccc148dbc23951b8a56df2f86fc5729b3765378cd",
  time: "2026-11-16T11:37:34.752Z",
  pubdata: {
    l2_transfer_pubdata_v2: {
      from_account_index: "693073", to_account_index: "675395", fee_account_index: "675395", asset_index: "USDC",
      from_route_type: "PERPS", to_route_type: "PERPS", amount: "288.000000", usdc_fee: "0.000000",
    },
  },
  pubdata_type: "L2TransferV2",
  status: "executed",
};
const DEPOSIT: Entry = {
  tx_type: "L1Deposit",
  hash: "00000000001e5aa83d00000130000000000000000000000000000000000000000000000000000000",
  time: "2026-11-16T11:09:41.462Z",
  pubdata: {
    l1_deposit_pubdata_v2: {
      account_index: "693073", l1_address: "0x3a17bDE82706aaF297A0d721D5c31E4EB3c48B65", asset_index: "USDC",
      route_type: "PERPS", accepted_amount: "4655.780000",
    },
  },
  pubdata_type: "L1DepositV2",
  status: "executed",
};
const LEVERAGE: Entry = {
  tx_type: "L2UpdateLeverage",
  hash: "f10e20d01e35b7bd8d854f411a5d10c17061a91029f81050c573610404ff9df04289adf45d8188e5",
  time: "2026-10-21T17:18:05.132Z",
  pubdata: { l2_update_leverage_pubdata: { account_index: "693073", market_index: 184, initial_margin_fraction: 3333, margin_mode: 1 } },
  pubdata_type: "L2UpdateLeverage",
  status: "executed",
};
const BLOCKS: Record<string, { block_number: number; batch_number: number }> = {
  [TRANSFER.hash]: { block_number: 389911093, batch_number: 269246 },
  [DEPOSIT.hash]: { block_number: 389893328, batch_number: 269235 },
};

// Account 1000's transfer of 5 USDC to 675395 on 2025-12-30, which sits in both accounts' logs.
const TRANSFER_TO_675395: Entry = {
  tx_type: "L2Transfer",
  hash: "4246f9e46ea882f68fe1275bdf8bc7caabe1f6ae9b6a606c2205673ea88a031471bc6057a5be00a6",
  time: "2025-12-30T08:09:30.613Z",
  pubdata: {
    l2_transfer_pubdata_v2: {
      from_account_index: "1000", to_account_index: "675395", fee_account_index: "675395", asset_index: "USDC",
      from_route_type: "PERPS", to_route_type: "PERPS", amount: "5.000000", usdc_fee: "0.000000",
    },
  },
  pubdata_type: "L2TransferV2",
  status: "executed",
};

/** A time as the Explorer writes it: UTC, with trailing zeros cut from the seconds. */
const explorerTime = (ms: number) => new Date(ms).toISOString().replace(/\.?0+Z$/, "Z");

/** A made-up TradeWithFunding entry of 313004, with a hash as long as a real one. */
const trade = (n: number, ms: number): Entry => ({
  tx_type: "L2CreateOrder",
  hash: n.toString(16).padStart(80, "0"),
  time: explorerTime(ms),
  pubdata: { trade_pubdata_with_funding: { market_index: 0, taker_account_index: "313004", size: "0.0071" } },
  pubdata_type: "TradeWithFunding",
  status: "executed",
});

/** `count` trades `stepMs` apart, newest first, the newest at `newest`, numbered from `first`. */
const trades = (count: number, newest: number, stepMs = MINUTE, first = 0) =>
  Array.from({ length: count }, (_, i) => trade(first + i, newest - i * stepMs));

/**
 * The Explorer's account logs and `logs/{hash}`, and the exchange API's `accountsByL1Address`, on one
 * server. `logs` holds each account's log newest first and can change between pages; `afterPage`
 * runs after each page is answered. `page` and `detail` replace an answer.
 */
async function fakeLighter(
  t: TestContext,
  { logs, afterPage, page, detail, subAccounts = {} }: {
    logs: Record<number, Entry[]>;
    afterPage?: (account: number, offset: number) => void;
    page?: (account: number, offset: number) => Reply | undefined;
    detail?: (hash: string) => Reply | undefined;
    subAccounts?: Record<string, number[]>;
  },
) {
  const fake = {
    url: "",
    pages: [] as { account: number; offset: number; limit: number }[],
    details: [] as string[],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://lighter");
    const parts = url.pathname.split("/");
    let answer: Reply;
    if (url.pathname.startsWith("/api/accounts/")) {
      const account = Number(parts[3]);
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      fake.pages.push({ account, offset, limit });
      answer = page?.(account, offset) ?? { status: 200, body: (logs[account] ?? []).slice(offset, offset + limit) };
      afterPage?.(account, offset);
    } else if (url.pathname.startsWith("/api/logs/")) {
      const hash = decodeURIComponent(parts[3]!);
      fake.details.push(hash);
      const entry = Object.values(logs).flat().find((e) => e.hash === hash);
      answer = detail?.(hash)
        ?? (entry
          ? { status: 200, body: { ...entry, ...(BLOCKS[hash] ?? { block_number: null, batch_number: null }) } }
          : { status: 404, body: { error: `log ${hash} not found` } });
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
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

/** A clock that a sleep moves forward at once. */
function fakeClock(start = NOW): Clock {
  let now = start;
  return { now: () => now, sleep: async (ms) => void (now += ms) };
}

/** Runs the rest of the test from a folder whose addresses.json holds `addresses`, as a source runs from its package. */
async function addressesHold(t: TestContext, addresses: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "lighter-account-logs-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), JSON.stringify(addresses));
  process.chdir(dir);
}

/** One run. `saved` holds the checkpoints the warehouse has, by key. */
async function run(
  url: string,
  { start = START, saved = {}, retry = [], clock = fakeClock(), env = {} }: {
    start?: number;
    saved?: Record<string, unknown>;
    retry?: AccountLogsCall[];
    clock?: Clock;
    env?: Record<string, string>;
  } = {},
) {
  const source = accountLogsSource(clock);
  const parsed = source.env.parse({
    LIGHTER_EXPLORER_URL: url,
    LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: "45",
    LIGHTER_API_URL: url,
    LIGHTER_REQUESTS_PER_MINUTE: "60",
    START_TIME: new Date(start).toISOString(),
    ...env,
  });
  const batches: Batch<AccountLogsCall>[] = [];
  for await (const batch of source.extract(parsed, retry, { getCheckpoint: async (key) => saved[key] })) batches.push(batch);
  return batches;
}

const keyOf = (url: string, account: number, start = START) =>
  historyKey(["lighter", url, "account_logs", account, start, LEDGER_TYPES]);
const records = (batches: Batch<AccountLogsCall>[]) => batches.flatMap((b) => b.records);
const logIds = (batches: Batch<AccountLogsCall>[]) => records(batches).map((r) => r.id).filter((id) => id.startsWith("log:"));
const failures = (batches: Batch<AccountLogsCall>[]) => batches.flatMap((b) => b.failed);
const checkpoints = (batches: Batch<AccountLogsCall>[]) => batches.flatMap((b) => b.checkpoints ?? []);
const idsOf = (account: number, entries: Entry[]) => entries.map((e) => `log:${account}:${e.hash}`);

test("walks pages newest first by offset until an entry older than since, and keeps none older", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const log = trades(250, NOW - 10 * MINUTE);
  const fake = await fakeLighter(t, { logs: { 313004: log } });

  const batches = await run(fake.url, { start: Date.parse(log[179]!.time) });

  assert.deepEqual(fake.pages, [{ account: 313004, offset: 0, limit: 100 }, { account: 313004, offset: 100, limit: 100 }]);
  assert.deepEqual(logIds(batches), idsOf(313004, log.slice(0, 180)));
  assert.deepEqual(records(batches)[0], { id: `log:313004:${log[0]!.hash}`, callId: "walk:313004#0", data: { account_index: 313004, entry: log[0] } });
  assert.deepEqual(records(batches)[179], { id: `log:313004:${log[179]!.hash}`, callId: "walk:313004", data: { account_index: 313004, entry: log[179] } });
});

test("an entry pushed onto the next page is written once", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const log = trades(150, NOW - 10 * MINUTE);
  const old = [...log];
  const fake = await fakeLighter(t, {
    logs: { 313004: log },
    // Two entries arrive after page 0, so page 1 starts with page 0's last two.
    afterPage: (_account, offset) => {
      if (offset === 0) log.unshift(...trades(2, NOW, MINUTE, 1000));
    },
  });

  const batches = await run(fake.url, { start: NOW - DAY });

  assert.equal(fake.pages.length, 2);
  assert.deepEqual(logIds(batches), idsOf(313004, old));
});

test("a page that repeats the previous one fails the walk", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const log = trades(150, NOW - 10 * MINUTE);
  // An Explorer that ignored offset would send page 0 for every page.
  const fake = await fakeLighter(t, { logs: { 313004: log }, page: () => ({ status: 200, body: log.slice(0, 100) }) });

  const batches = await run(fake.url, { start: NOW - DAY });

  const [failure] = failures(batches);
  assert.equal(failure!.id, "walk:313004");
  assert.deepEqual(failure!.call, { kind: "walk", account_index: 313004, since: NOW - DAY });
  assert.match(failure!.error, /repeated/);
  assert.equal(fake.pages.length, 2);
  assert.deepEqual(checkpoints(batches), []);
});

test("a walk that reaches MAX_PAGES_PER_WALK pages fails as a dead letter, naming the account and the limit", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  // One entry a page, and one entry more than the limit lets a walk read, all newer than since.
  const log = trades(MAX_PAGES_PER_WALK + 1, NOW - 10 * MINUTE, 1000);
  const fake = await fakeLighter(t, { logs: { 313004: log } });

  const batches = await run(fake.url, { start: NOW - DAY, env: { LIGHTER_LOG_PAGE_SIZE: "1" } });

  assert.equal(fake.pages.length, MAX_PAGES_PER_WALK);
  assert.deepEqual(failures(batches).map((f) => [f.id, f.error]), [
    ["walk:313004", `Account 313004's log ran past ${MAX_PAGES_PER_WALK} pages, the most one walk reads, without reaching the walk's since`],
  ]);
  assert.deepEqual(logIds(batches), idsOf(313004, log.slice(0, MAX_PAGES_PER_WALK)));
  assert.deepEqual(checkpoints(batches), []);
});

test("reads logs/{hash} for detail types only", async (t) => {
  await addressesHold(t, { accounts: [693073] });
  const fake = await fakeLighter(t, { logs: { 693073: [TRADE, TRANSFER, DEPOSIT, LEVERAGE] } });

  const batches = await run(fake.url, { start: Date.parse("2026-10-01T00:00:00Z") });

  assert.deepEqual(fake.details, [TRANSFER.hash, DEPOSIT.hash]);
  assert.deepEqual(logIds(batches), idsOf(693073, [TRADE, TRANSFER, DEPOSIT, LEVERAGE]));
  assert.deepEqual(
    records(batches).filter((r) => r.id.startsWith("detail:")),
    [TRANSFER, DEPOSIT].map((e) => ({ id: `detail:${e.hash}`, callId: `detail:${e.hash}`, data: { ...e, ...BLOCKS[e.hash] } })),
  );
});

test("a failed page fails its walk as a dead letter; pages before it stay, and only the last page clears it", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  const log = trades(150, NOW - 10 * MINUTE);
  let broken = true;
  const fake = await fakeLighter(t, {
    logs: { 313004: log },
    page: (_account, offset) => (broken && offset === 100 ? { status: 400, body: { error: "boom" } } : undefined),
  });

  const batches = await run(fake.url);

  assert.deepEqual(batches.map((b) => [...new Set(b.records.map((r) => r.callId))]), [["walk:313004#0"]]);
  assert.equal(batches.at(-1)!.failed[0]!.id, "walk:313004");
  assert.deepEqual(logIds(batches), idsOf(313004, log.slice(0, 100)));
  assert.deepEqual(checkpoints(batches), []);

  // The retry merges into this run's walk with the earlier since: with no overlap, the fresh walk alone
  // would stop at the newest entry the saved checkpoint names.
  broken = false;
  fake.pages.length = 0;
  const saved = { [keyOf(fake.url, 313004)]: { account_index: 313004, origin: START, newest: NOW - 10 * MINUTE, read_at: NOW - 5 * MINUTE } };
  const retried = await run(fake.url, { saved, retry: [batches.at(-1)!.failed[0]!.call], env: { HISTORY_OVERLAP_DAYS: "0" } });

  assert.deepEqual(fake.pages.map((p) => p.offset), [0, 100]);
  assert.deepEqual(retried.map((b) => [...new Set(b.records.map((r) => r.callId))]), [["walk:313004#0", "walk:313004"]]);
  assert.deepEqual(logIds(retried), idsOf(313004, log));
});

test("the next run walks back to the newest entry it saw, less the overlap", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  // An entry every 30 minutes from START_TIME to two days after it, newest first.
  const log = trades(97, START + 2 * DAY, 30 * MINUTE);
  const fake = await fakeLighter(t, { logs: { 313004: log } });
  const key = keyOf(fake.url, 313004);
  const pages = { LIGHTER_LOG_PAGE_SIZE: "10" };

  const first = await run(fake.url, { clock: fakeClock(START + 2 * DAY + 5 * MINUTE), env: pages });

  assert.equal(logIds(first).length, 97);
  assert.deepEqual(checkpoints(first), [
    { key, value: { account_index: 313004, origin: START, newest: START + 2 * DAY, read_at: START + 2 * DAY + 5 * MINUTE } },
  ]);

  // Four entries arrive. The next run reads back to a day before the newest entry the first one saw:
  // the 4 new ones and 49 old ones, indexes 0 to 52. Index 53 is older and sits on page 5.
  log.unshift(...trades(4, START + 2 * DAY + 120 * MINUTE, 30 * MINUTE, 1000));
  fake.pages.length = 0;
  const second = await run(fake.url, { saved: { [key]: checkpoints(first)[0]!.value }, env: pages });

  assert.deepEqual(fake.pages.map((p) => p.offset), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(logIds(second), idsOf(313004, log.slice(0, 53)));
  assert.deepEqual(checkpoints(second), [
    { key, value: { account_index: 313004, origin: START, newest: START + 2 * DAY + 120 * MINUTE, read_at: NOW } },
  ]);
});

test("a failed detail waits as its own dead letter", async (t) => {
  await addressesHold(t, { accounts: [693073] });
  let missing = true;
  const fake = await fakeLighter(t, {
    logs: { 693073: [TRANSFER, DEPOSIT] },
    detail: (hash) => (missing && hash === DEPOSIT.hash ? { status: 404, body: { error: `log ${hash} not found` } } : undefined),
  });

  const batches = await run(fake.url);

  assert.deepEqual(failures(batches), [{
    id: `detail:${DEPOSIT.hash}`,
    call: { kind: "detail", hash: DEPOSIT.hash },
    error: `Lighter's Explorer answered HTTP 404 for /api/logs/${DEPOSIT.hash}: log ${DEPOSIT.hash} not found`,
  }]);
  assert.deepEqual(records(batches).map((r) => r.callId), ["walk:693073", "walk:693073", `detail:${TRANSFER.hash}`]);
  assert.equal(checkpoints(batches).length, 1);

  // The next run's walk stops before the deposit, and the retry reads its detail.
  missing = false;
  fake.details.length = 0;
  const saved = { [keyOf(fake.url, 693073)]: checkpoints(batches)[0]!.value };
  const retried = await run(fake.url, { saved, retry: [failures(batches)[0]!.call], env: { HISTORY_OVERLAP_DAYS: "0" } });

  assert.deepEqual(fake.details, [TRANSFER.hash, DEPOSIT.hash]);
  assert.deepEqual(failures(retried), []);
  assert.deepEqual(records(retried).at(-1), { id: `detail:${DEPOSIT.hash}`, callId: `detail:${DEPOSIT.hash}`, data: { ...DEPOSIT, ...BLOCKS[DEPOSIT.hash] } });
});

test("an L1 address in addresses.json walks each of its sub-accounts", async (t) => {
  const address = "0x2222222222222222222222222222222222222222";
  await addressesHold(t, { accounts: [313004], l1_addresses: [address] });
  const logs = { 313004: trades(1, NOW, MINUTE, 1), 700001: trades(1, NOW, MINUTE, 2), 700002: trades(1, NOW, MINUTE, 3) };
  const fake = await fakeLighter(t, { logs, subAccounts: { [address]: [700002, 700001] } });

  const batches = await run(fake.url, { start: NOW - DAY });

  assert.deepEqual(fake.pages.map((p) => p.account), [313004, 700001, 700002]);
  assert.deepEqual(logIds(batches), [...idsOf(313004, logs[313004]), ...idsOf(700001, logs[700001]), ...idsOf(700002, logs[700002])]);
});

test("a transfer between two listed accounts is written under each account", async (t) => {
  await addressesHold(t, { accounts: [1000, 675395] });
  const fake = await fakeLighter(t, { logs: { 1000: [TRANSFER_TO_675395], 675395: [TRANSFER_TO_675395] } });

  const batches = await run(fake.url, { start: Date.parse("2025-12-30T00:00:00Z") });

  assert.deepEqual(logIds(batches), [`log:1000:${TRANSFER_TO_675395.hash}`, `log:675395:${TRANSFER_TO_675395.hash}`]);
  // One lookup serves both accounts.
  assert.deepEqual(fake.details, [TRANSFER_TO_675395.hash]);
});

test("an entry time with no zone fails the walk, quoting it", async (t) => {
  await addressesHold(t, { accounts: [313004] });
  // Date.parse would read this as local time.
  const entry = { ...trade(0, NOW), time: "2026-11-18T11:59:00.5" };
  const fake = await fakeLighter(t, { logs: { 313004: [entry] } });

  const batches = await run(fake.url, { start: NOW - DAY });

  assert.deepEqual(failures(batches).map((f) => [f.id, f.error]), [
    ["walk:313004", "Lighter's Explorer sent a time it cannot read: 2026-11-18T11:59:00.5"],
  ]);
  assert.deepEqual(records(batches), []);
});

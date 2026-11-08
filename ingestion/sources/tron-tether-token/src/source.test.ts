import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal, type MockPortalBlock } from "@subsquid/pipes/testing";
import { tronTetherToken, type TronTetherTokenEnv } from "#src/source.ts";

const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const USDT_HEX = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";
// Two accounts whose Base58Check spelling TronGrid's wallet/getcontract states.
const MULTISIG = {
  hex: "0fa695d6b065707cb4e0ef73b751c93347682bf2",
  base58: "TBPxhVAsuzoFnKyXtc1o2UySEydPHgATto",
};
const DEPLOYER = {
  hex: "6f113b919b670f3579e4f680830d9709baf52ac0",
  base58: "TL6Uehakg6iZDcU6ggaQDcp4oVVJpkU36a",
};
const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MIDNIGHT_MS = Date.UTC(2026, 10, 6);

const word = (hex: string) => hex.padStart(64, "0");
const transfer = (transactionIndex: number, logIndex: number, value: bigint, address = USDT_HEX) =>
  ({
    transactionIndex,
    logIndex,
    address,
    data: word(value.toString(16)),
    topics: [TRANSFER_TOPIC, word(MULTISIG.hex), word(DEPLOYER.hex)],
  });
const transaction = (transactionIndex: number, owner: string, result = "SUCCESS") => ({
  transactionIndex,
  hash: word(`ab${transactionIndex}`),
  type: "TriggerSmartContract",
  result,
  ret: [{ contractRet: result }],
  parameter: {
    value: { owner_address: `41${owner}`, contract_address: `41${USDT_HEX}`, data: "a9059cbb" },
    type_url: "type.googleapis.com/protocol.TriggerSmartContract",
  },
});
const header = (number: number) => ({
  number,
  hash: word(`b${number}`),
  timestamp: MIDNIGHT_MS + (number - 101) * 3000,
});

// Block 101: two transactions whose Transfers both have log index 0, and one with no log.
const blocks: MockPortalBlock[] = [
  {
    header: header(101),
    logs: [transfer(0, 0, 1_000_000n), transfer(1, 0, 10n ** 30n)],
    transactions: [
      transaction(0, MULTISIG.hex),
      transaction(1, DEPLOYER.hex, "REVERT"),
      transaction(2, MULTISIG.hex),
    ],
  },
  { header: header(102) },
];

/** Runs the rest of the test from a folder whose addresses.json holds `json`, as a source runs. */
async function addressesHold(t: TestContext, json: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "tron-tether-token-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), JSON.stringify(json));
  process.chdir(dir);
}

async function portal(t: TestContext, chain: MockPortalBlock[]) {
  const mock = await mockPortal({ blocks: chain, kind: "tron" });
  t.after(() => mock.close());
  return mock.url;
}

async function records(env: TronTetherTokenEnv): Promise<RawRecord[]> {
  const stream = await tronTetherToken.stream(env);
  const read: RawRecord[] = [];
  for await (const { data } of stream) {
    read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  }
  return read;
}

const byId = (read: RawRecord[]) => {
  for (const record of read) assert.equal(record.callId, record.id, "a record answers no call");
  return Object.fromEntries(read.map((record) => [record.id, record.data]));
};

const transferLog = (txIndex: number, value: string) => ({
  kind: "log",
  event: "Transfer",
  block_number: 101,
  block_hash: word("b101"),
  timestamp: "2026-11-06T00:00:00.000Z",
  tx_hash: word(`ab${txIndex}`),
  tx_index: txIndex,
  log_index: 0,
  contract: USDT,
  args: { from: MULTISIG.base58, to: DEPLOYER.base58, value },
});
const transactionRow = (txIndex: number, owner: string, result: string) => ({
  kind: "transaction",
  block_number: 101,
  tx_index: txIndex,
  hash: word(`ab${txIndex}`),
  type: "TriggerSmartContract",
  result,
  contract_ret: result,
  owner,
});
const blockRow = (number: number, timestamp: string) => ({
  kind: "block",
  block_number: number,
  block_hash: word(`b${number}`),
  timestamp,
});

test("every block, each tracked log and its transaction become the spec's records", async (t) => {
  await addressesHold(t, { tokens: [USDT] });
  const env = { PORTAL_URL: await portal(t, blocks), START_BLOCK: 101, END_BLOCK: 102 };
  assert.deepEqual(
    byId(await records(env)),
    {
      "block:101": blockRow(101, "2026-11-06T00:00:00.000Z"),
      "block:102": blockRow(102, "2026-11-06T00:00:03.000Z"),
      "101:0:0": transferLog(0, "1000000"),
      "101:1:0": transferLog(1, "1000000000000000000000000000000"),
      [`tx:${word("ab0")}`]: transactionRow(0, MULTISIG.base58, "SUCCESS"),
      [`tx:${word("ab1")}`]: transactionRow(1, DEPLOYER.base58, "REVERT"),
    },
    "no record for transaction 2, which has no tracked log",
  );
});

test("two logs with log index 0 in two transactions of one block get two ids", async (t) => {
  await addressesHold(t, { tokens: [USDT] });
  const env = { PORTAL_URL: await portal(t, blocks), START_BLOCK: 101, END_BLOCK: 101 };
  const logs = (await records(env)).filter((record) => record.data.kind === "log");
  assert.deepEqual(logs.map((record) => record.data.log_index), [0, 0]);
  assert.deepEqual(new Set(logs.map((record) => record.id)), new Set(["101:0:0", "101:1:0"]));
});

test("a rerun over the same blocks writes the same ids and rows", async (t) => {
  await addressesHold(t, { tokens: [USDT] });
  const env = { PORTAL_URL: await portal(t, blocks), START_BLOCK: 101, END_BLOCK: 102 };
  assert.deepEqual(byId(await records(env)), byId(await records(env)));
});

test("DestroyedBlackFunds decodes its indexed user in Base58Check", async (t) => {
  // Block 86646549, transaction 08f6a282..., log 1, as Portal returns it.
  const proof: MockPortalBlock = {
    header: { number: 86646549, hash: word("52a1f15"), timestamp: 1790612100000 },
    logs: [
      {
        transactionIndex: 33,
        logIndex: 1,
        address: USDT_HEX,
        data: word("f12d2c9b0"),
        topics: [
          "61e6e66b0d6339b2980aecc6ccc0039736791f0ccde9ed512e789a7fbdd698c6",
          word("b87e72d3b93c86af842a15c7a695275a316de659"),
        ],
      },
    ],
    transactions: [transaction(33, "a89ae0805bbc6b0d7912d7103f216f3f2ff04f97")],
  };
  await addressesHold(t, { tokens: [USDT] });
  const env = { PORTAL_URL: await portal(t, [proof]), START_BLOCK: 86646549, END_BLOCK: 86646549 };
  const log = byId(await records(env))["86646549:33:1"]!;
  assert.equal(log.event, "DestroyedBlackFunds");
  assert.equal(log.timestamp, "2026-09-28T16:15:00.000Z");
  // The user's Base58Check spelling comes from a separate Python Base58Check script.
  assert.deepEqual(log.args, {
    _blackListedUser: "TSnip9vKvo4AAoZHekS6jUgJ1ARnQX3roP",
    _balance: "64740313520",
  });
});

test("a log of a contract outside addresses.json fails the run instead of loading", async (t) => {
  const stray: MockPortalBlock = {
    header: header(101),
    logs: [transfer(0, 0, 1n, MULTISIG.hex)],
    transactions: [transaction(0, MULTISIG.hex)],
  };
  await addressesHold(t, { tokens: [USDT] });
  const env = { PORTAL_URL: await portal(t, [stray]), START_BLOCK: 101, END_BLOCK: 101 };
  await assert.rejects(records(env), new RegExp(`a log of ${MULTISIG.base58}, which is no`));
});

test("addresses.json with wallets, or with a token that is no address, fails", async (t) => {
  const env = { PORTAL_URL: "http://127.0.0.1:1", START_BLOCK: 1 };
  await addressesHold(t, { tokens: [USDT], wallets: [MULTISIG.base58] });
  await assert.rejects(tronTetherToken.stream(env), /addresses\.json: .*wallets/s);
  await writeFile("addresses.json", JSON.stringify({ tokens: [USDT.toLowerCase()] }));
  await assert.rejects(tronTetherToken.stream(env), {
    message: `Invalid TRON addresses:\n  ${USDT.toLowerCase()}`,
  });
});

test("the source loads raw.tron_tether_token and refuses END_BLOCK before START_BLOCK", () => {
  assert.equal(tronTetherToken.name, "tron");
  assert.equal(tronTetherToken.table, "tether_token");
  const parsed = tronTetherToken.env.safeParse({
    PORTAL_URL: "http://127.0.0.1:1",
    START_BLOCK: "5",
    END_BLOCK: "4",
  });
  assert.match(parsed.error!.message, /END_BLOCK must not be before START_BLOCK/);
});

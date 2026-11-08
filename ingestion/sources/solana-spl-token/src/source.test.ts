// The source streams slots from a mock Portal that sends each slot as the test gives it, so every
// filter the records show is the source's own. The slots are specification fixtures: made-up
// accounts and amounts, shaped like Portal's solana-mainnet replies.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { getAddressDecoder, getAddressEncoder, getBase58Decoder, type Address } from "@solana/kit";
import { mockPortal } from "@subsquid/pipes/testing";
import { readMints, solanaSplToken, type SplTokenEnv } from "#src/source.ts";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const base58 = getBase58Decoder();
const filled = (n: number, size: number) => {
  const bytes = new Uint8Array(size).fill(7);
  new DataView(bytes.buffer).setUint32(0, n);
  return bytes;
};
const addressOf = (n: number): string => getAddressDecoder().decode(filled(n, 32));
const signatureOf = (n: number) => base58.decode(filled(n, 64));
const addressBytes = (address: string) => [...getAddressEncoder().encode(address as Address)];
const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return [...bytes];
};
const data = (...bytes: number[]) => base58.decode(Uint8Array.from(bytes));

const alice = addressOf(1);
const bob = addressOf(2);
const carol = addressOf(3);
const owner = addressOf(4);
const otherMint = addressOf(5);
const otherA = addressOf(6);
const otherB = addressOf(7);
const ephemeral = addressOf(8);
const otherEphemeral = addressOf(9);
const router = addressOf(10);
const paid = signatureOf(1);
const failed = signatureOf(2);
const passThrough = signatureOf(3);
const batched = signatureOf(4);
const SLOT = 100;

type Side = { amount: string } | null;
function balance(txIndex: number, account: string, mint: string, pre: Side, post: Side) {
  const side = (prefix: "pre" | "post", amount: string) => ({
    [`${prefix}Mint`]: mint,
    [`${prefix}Owner`]: owner,
    [`${prefix}Amount`]: amount,
    [`${prefix}Decimals`]: 6,
    [`${prefix}ProgramId`]: TOKEN,
  });
  return {
    transactionIndex: txIndex,
    account,
    ...(pre && side("pre", pre.amount)),
    ...(post && side("post", post.amount)),
  };
}

const call = (
  txIndex: number,
  address: number[],
  programId: string,
  accounts: string[],
  bytes: string,
) => ({
  transactionIndex: txIndex,
  instructionAddress: address,
  programId,
  accounts,
  data: bytes,
  isCommitted: txIndex !== 1,
});
const transfer = (amount: bigint) => data(3, ...u64(amount));
const transferChecked = (amount: bigint) => data(12, ...u64(amount), 6);
const initializeAccount3 = data(18, ...addressBytes(owner));
// A Batch of transfers: each packed instruction is its account count, its data length, then its data.
const batch = (...transfers: [accounts: number, tag: number, amount: bigint][]) =>
  data(255, ...transfers.flatMap(([accounts, tag, amount]) => [accounts, 9, tag, ...u64(amount)]));

// Transaction 0 pays alice to bob through a router and directly. Transaction 1 fails. Transaction 2
// routes carol's payment through an account made, used and closed inside it, so Portal has no
// balance for that account. Transaction 3 is one Batch that packs a transfer of another mint and a
// transfer from carol to bob.
const busy = {
  header: { number: SLOT, hash: base58.decode(filled(SLOT, 32)), timestamp: 1794009600 },
  transactions: [
    { transactionIndex: 0, signatures: [paid], err: null },
    { transactionIndex: 1, signatures: [failed], err: { InstructionError: [0, { Custom: 1 }] } },
    { transactionIndex: 2, signatures: [passThrough], err: null },
    { transactionIndex: 3, signatures: [batched], err: null },
  ],
  tokenBalances: [
    balance(0, alice, MINT, { amount: "9007199254740993" }, { amount: "9007199254740990" }),
    balance(0, bob, MINT, null, { amount: "3" }),
    balance(0, otherA, otherMint, { amount: "5" }, { amount: "4" }),
    balance(1, alice, MINT, { amount: "7" }, { amount: "7" }),
    balance(2, carol, MINT, { amount: "10" }, { amount: "8" }),
    balance(2, bob, MINT, { amount: "3" }, { amount: "5" }),
    balance(3, carol, MINT, { amount: "8" }, { amount: "6" }),
    balance(3, bob, MINT, { amount: "5" }, { amount: "7" }),
  ],
  instructions: [
    call(0, [0], COMPUTE_BUDGET, [], data(2, 0, 0, 1, 0)),
    call(0, [1], router, [alice, bob], data(1)),
    call(0, [1, 0], TOKEN, [alice, bob, owner], transfer(1n)),
    call(0, [1, 1], TOKEN, [otherA, otherB, owner], transfer(1n)),
    call(0, [2], TOKEN, [alice, MINT, bob, owner], transferChecked(2n)),
    call(0, [2, 0], TOKEN, [alice, bob, owner], transfer(0n)),
    call(1, [0], TOKEN, [alice, MINT, bob, owner], transferChecked(7n)),
    call(2, [0], router, [ephemeral], data(1)),
    call(2, [0, 3], TOKEN, [ephemeral, MINT], initializeAccount3),
    call(2, [0, 4], TOKEN, [otherEphemeral, otherMint], initializeAccount3),
    call(2, [1], TOKEN, [carol, MINT, ephemeral, owner], transferChecked(2n)),
    call(2, [2], TOKEN, [ephemeral, MINT, bob, owner], transferChecked(2n)),
    call(2, [3], TOKEN, [ephemeral, owner, owner], data(9)),
    call(2, [4], TOKEN, [otherEphemeral, otherB, owner], transfer(1n)),
    call(3, [0], TOKEN, [otherA, otherB, owner, carol, bob, owner], batch([3, 3, 1n], [3, 3, 2n])),
  ],
};
const empty = (slot: number) => ({
  header: { number: slot, hash: base58.decode(filled(slot, 32)), timestamp: 1794009500 + slot },
});

async function portal(t: TestContext) {
  const blocks = [empty(SLOT - 1), busy, empty(SLOT + 1)];
  const mock = await mockPortal({ blocks, kind: "solana" });
  t.after(() => mock.close());
  return mock.url;
}

const env = (url: string): SplTokenEnv => ({
  PORTAL_URL: url,
  START_BLOCK: SLOT - 1,
  END_BLOCK: SLOT + 1,
});

/** Writes `json` to an addresses.json of its own and returns its path. */
async function addressesFile(t: TestContext, json: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "solana-spl-token-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "addresses.json");
  await writeFile(path, typeof json === "string" ? json : JSON.stringify(json));
  return path;
}

// The stream reads the package's own addresses.json, as a run does from the package's folder.
async function records(t: TestContext): Promise<RawRecord[]> {
  const stream = await solanaSplToken.stream(env(await portal(t)));
  const read: RawRecord[] = [];
  for await (const { data } of stream) {
    read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  }
  return read;
}

const byId = (read: RawRecord[], id: string) => {
  const found = read.find((r) => r.id === id);
  assert.ok(found, `no record ${id}`);
  return found.data;
};

test("every slot becomes a block record, with its hash and time", async (t) => {
  const read = await records(t);
  assert.deepEqual(
    read.filter((r) => r.data.kind === "block").map((r) => r.id),
    ["block:99", "block:100", "block:101"],
  );
  assert.deepEqual(byId(read, "block:100"), {
    kind: "block",
    slot: SLOT,
    block_hash: busy.header.hash,
    timestamp: "2026-11-07T00:00:00.000Z",
  });
});

test("records are keyed by place in the chain; inner and outer instructions differ", async (t) => {
  const read = await records(t);
  assert.ok(read.every((r) => r.callId === r.id), "a stream record answers no call but its own");
  assert.deepEqual(
    read.filter((r) => r.data.kind !== "block").map((r) => r.id),
    [
      `tx:${paid}`,
      `bal:100:0:${alice}`,
      `bal:100:0:${bob}`,
      "100:0:1.0",
      "100:0:2",
      "100:0:2.0",
      `tx:${failed}`,
      `bal:100:1:${alice}`,
      "100:1:0",
      `tx:${passThrough}`,
      `bal:100:2:${carol}`,
      `bal:100:2:${bob}`,
      "100:2:0.3",
      "100:2:1",
      "100:2:2",
      "100:2:3",
      `tx:${batched}`,
      `bal:100:3:${carol}`,
      `bal:100:3:${bob}`,
      "100:3:0",
      "100:3:0.1",
    ],
    "no other mint's balance or SPL Token instruction, and no other program's instruction",
  );
});

test("a rerun writes the same rows", async (t) => {
  assert.deepEqual(await records(t), await records(t));
});

test("a transaction, a balance and an instruction carry the fields the models read", async (t) => {
  const read = await records(t);
  assert.deepEqual(byId(read, `tx:${paid}`), {
    kind: "transaction",
    slot: SLOT,
    tx_index: 0,
    signature: paid,
    err: null,
  });
  assert.deepEqual(byId(read, `bal:100:0:${bob}`), {
    kind: "token_balance",
    slot: SLOT,
    tx_index: 0,
    signature: paid,
    account: bob,
    pre_mint: null,
    post_mint: MINT,
    pre_owner: null,
    post_owner: owner,
    pre_amount: null,
    post_amount: "3",
    pre_decimals: null,
    post_decimals: 6,
    pre_program_id: null,
    post_program_id: TOKEN,
  });
  const large = byId(read, `bal:100:0:${alice}`).pre_amount;
  assert.equal(large, "9007199254740993", "past 2^53, as text");
  assert.deepEqual(byId(read, "100:0:2"), {
    kind: "instruction",
    slot: SLOT,
    tx_index: 0,
    signature: paid,
    instruction_address: [2],
    program_id: TOKEN,
    accounts: [alice, MINT, bob, owner],
    data: transferChecked(2n),
    is_committed: true,
    instruction: "transferChecked",
    args: { amount: "2", decimals: 6 },
    named_accounts: { source: alice, tokenMint: MINT, destination: bob, owner },
    packed_in: null,
  });
});

test("a failed transaction is written with its error, instructions not committed", async (t) => {
  const read = await records(t);
  assert.deepEqual(byId(read, `tx:${failed}`).err, { InstructionError: [0, { Custom: 1 }] });
  assert.equal(byId(read, "100:1:0").is_committed, false);
  const unchanged = byId(read, `bal:100:1:${alice}`);
  assert.equal(unchanged.pre_amount, unchanged.post_amount);
});

test("an account made and closed in a transaction keeps every instruction on it", async (t) => {
  const read = await records(t);
  assert.equal(byId(read, "100:2:0.3").instruction, "initializeAccount3");
  assert.deepEqual(byId(read, "100:2:3").named_accounts, {
    closeAccount: ephemeral,
    destination: owner,
    owner,
  });
  assert.equal(
    read.some((r) => (r.data.accounts as string[] | undefined)?.includes(otherEphemeral)),
    false,
    "an account made for another mint ties nothing to the tracked mint",
  );
});

test("a Batch is kept with each instruction it packs, at the Batch's address", async (t) => {
  const read = await records(t);
  const outer = byId(read, "100:3:0");
  assert.equal(outer.instruction, "batch");
  assert.deepEqual(outer.args, { instructions: 2 });
  assert.equal(outer.packed_in, null);
  const packed = byId(read, "100:3:0.1");
  assert.equal(packed.instruction, "transfer");
  assert.deepEqual(packed.instruction_address, [0, 1]);
  assert.deepEqual(packed.accounts, [carol, bob, owner]);
  assert.deepEqual(packed.args, { amount: "2" });
  assert.deepEqual(packed.packed_in, [0]);
  assert.equal(
    read.some((r) => r.id === "100:3:0.0"),
    false,
    "the packed transfer of another mint touches no tracked account",
  );
});

test("Base58 text is written byte for byte", async (t) => {
  const read = await records(t);
  const tx = byId(read, `tx:${passThrough}`);
  assert.equal(tx.signature, passThrough);
  assert.notEqual(passThrough.toLowerCase(), passThrough, "the fixture is mixed case");
  assert.equal(byId(read, `bal:100:2:${carol}`).post_mint, MINT);
  assert.deepEqual(byId(read, "100:2:1").accounts, [carol, MINT, ephemeral, owner]);
});

test("addresses.json lists mints only, as Solana addresses", async (t) => {
  const withWallets = await addressesFile(t, { mints: [MINT], wallets: [alice] });
  assert.throws(() => readMints(withWallets), /lists wallets, but this source loads every holder/);
  const bad = await addressesFile(t, { mints: ["not-an-address"] });
  assert.throws(() => readMints(bad), { message: "Invalid Solana addresses:\n  not-an-address" });
  const none = await addressesFile(t, { mints: [] });
  assert.throws(() => readMints(none), /addresses\.json is invalid/);
  const malformed = await addressesFile(t, '{ "mints": [], }');
  assert.throws(() => readMints(malformed), /addresses\.json is not valid JSON/);
  assert.deepEqual(readMints("addresses.json"), [MINT], "the package's own file names the mint");
});

test("a skipped END_BLOCK is refused: Pipes would ask Portal for it without end", async (t) => {
  // A Portal whose head is slot 200 and whose next block from slot 101 on is 102.
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    if (req.url === "/finalized-head") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ number: 200, hash: "Head" }));
    }
    res.setHeader("content-type", "application/jsonl");
    res.end(JSON.stringify({ header: { number: 102 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await assert.rejects(
    solanaSplToken.stream({ PORTAL_URL: url, START_BLOCK: 90, END_BLOCK: 101 }),
    /END_BLOCK 101 was skipped and has no block: set it to one that has, such as 102/,
  );
});

test("the source loads raw.solana_spl_token, and END_BLOCK before START_BLOCK is refused", () => {
  assert.equal(solanaSplToken.name, "solana");
  assert.equal(solanaSplToken.table, "spl_token");
  const backwards = { PORTAL_URL: "http://127.0.0.1:1", START_BLOCK: "10", END_BLOCK: "9" };
  const parsed = solanaSplToken.env.safeParse(backwards);
  assert.equal(parsed.success, false);
});

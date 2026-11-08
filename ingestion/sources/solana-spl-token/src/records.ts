import assert from "node:assert/strict";
import type { RawRecord } from "@ingestion/lib";
import type { SolanaPortalData } from "@subsquid/pipes/solana";
import {
  ACCOUNT_INITIALIZERS,
  TOKEN_PROGRAM_ID,
  decodeTokenInstruction,
  type DecodedInstruction,
} from "#src/instructions.ts";

/** The fields the source asks Portal for, and so the fields of a Slot. */
export const FIELDS = {
  block: { number: true, hash: true, timestamp: true },
  transaction: { transactionIndex: true, signatures: true, err: true },
  instruction: {
    transactionIndex: true,
    instructionAddress: true,
    programId: true,
    accounts: true,
    data: true,
    isCommitted: true,
  },
  tokenBalance: {
    transactionIndex: true,
    account: true,
    preMint: true,
    postMint: true,
    preOwner: true,
    postOwner: true,
    preAmount: true,
    postAmount: true,
    preDecimals: true,
    postDecimals: true,
    preProgramId: true,
    postProgramId: true,
  },
} as const;

/** One slot as Portal returns it: its header, and the items the query matched in it. */
export type Slot = SolanaPortalData<typeof FIELDS>[number];
type Transaction = Slot["transactions"][number];
type Instruction = Slot["instructions"][number];
type TokenBalance = Slot["tokenBalances"][number];

type TransactionItems = {
  transaction: Transaction;
  balances: TokenBalance[];
  instructions: Instruction[];
};

/**
 * Every record of one slot: the slot itself, and for each transaction Portal matched, the
 * transaction, its balances of the tracked mints, and the SPL Token instructions that touch them.
 * Each record is keyed by its place in the chain, so a rerun writes the same rows.
 */
export function slotRecords(slot: Slot, mints: ReadonlySet<string>): RawRecord[] {
  assert.ok(mints.size > 0);
  const number = slot.header.number;
  const records: RawRecord[] = [
    record(`block:${number}`, {
      kind: "block",
      slot: number,
      block_hash: slot.header.hash,
      timestamp: new Date(slot.header.timestamp * 1000).toISOString(),
    }),
  ];
  for (const items of byTransaction(slot).values()) {
    const balances = items.balances.filter((balance) => isTracked(balance, mints));
    const accounts = new Set([...mints, ...balances.map((balance) => balance.account)]);
    const signature = items.transaction.signatures[0];
    assert.ok(signature !== undefined, "a transaction carries its signature");
    const at = { slot: number, tx_index: items.transaction.transactionIndex, signature };
    records.push(
      record(`tx:${signature}`, { kind: "transaction", ...at, err: items.transaction.err ?? null }),
      ...balances.map((balance) => balanceRecord(at, balance)),
      ...keptInstructions(items.instructions, accounts).map(([instruction, decoded]) =>
        instructionRecord(at, instruction, decoded),
      ),
    );
  }
  assert.equal(new Set(records.map((r) => r.id)).size, records.length, "ids are unique in a slot");
  return records;
}

/**
 * The SPL Token instructions to keep, in Portal's order, each with its decoding: those whose
 * accounts include a tracked mint or a token account with a tracked balance, and those that touch
 * a token account one of the first created. An account made and closed in the same transaction has
 * no balance in Portal, so only its initializeAccount* ties its transfers and closing to the mint.
 */
export function keptInstructions(
  instructions: readonly Instruction[],
  tracked: ReadonlySet<string>,
): [Instruction, DecodedInstruction | null][] {
  const decoded = instructions
    .filter((instruction) => instruction.programId === TOKEN_PROGRAM_ID)
    .map((instruction): [Instruction, DecodedInstruction | null] => [
      instruction,
      decodeTokenInstruction(instruction.accounts, instruction.data),
    ]);
  const touches = (instruction: Instruction, accounts: ReadonlySet<string>) =>
    instruction.accounts.some((account) => accounts.has(account));
  const created = new Set<string>();
  for (const [instruction, decoding] of decoded) {
    if (!touches(instruction, tracked)) continue;
    if (decoding === null) continue;
    if (!ACCOUNT_INITIALIZERS.has(decoding.instruction)) continue;
    const account = instruction.accounts[0];
    assert.ok(account !== undefined, "an initializeAccount* names the new account first");
    created.add(account);
  }
  const kept = decoded.filter(
    ([instruction]) => touches(instruction, tracked) || touches(instruction, created),
  );
  assert.ok(kept.length <= decoded.length);
  return kept;
}

/** The transactions of a slot by index, each with its token balances and instructions. */
function byTransaction(slot: Slot): Map<number, TransactionItems> {
  const items = new Map<number, TransactionItems>();
  for (const transaction of slot.transactions) {
    assert.ok(!items.has(transaction.transactionIndex), "one transaction per index");
    items.set(transaction.transactionIndex, { transaction, balances: [], instructions: [] });
  }
  // Portal sends each matched item's transaction, as the query asks.
  for (const balance of slot.tokenBalances) {
    const of = items.get(balance.transactionIndex);
    assert.ok(of !== undefined, `slot ${slot.header.number}: a balance without its tx`);
    of.balances.push(balance);
  }
  for (const instruction of slot.instructions) {
    const of = items.get(instruction.transactionIndex);
    assert.ok(of !== undefined, `slot ${slot.header.number}: an instruction without its tx`);
    of.instructions.push(instruction);
  }
  return items;
}

const isTracked = (balance: TokenBalance, mints: ReadonlySet<string>) =>
  (balance.preMint !== undefined && mints.has(balance.preMint)) ||
  (balance.postMint !== undefined && mints.has(balance.postMint));

type At = { slot: number; tx_index: number; signature: string };

function balanceRecord(at: At, balance: TokenBalance): RawRecord {
  return record(`bal:${at.slot}:${at.tx_index}:${balance.account}`, {
    kind: "token_balance",
    ...at,
    account: balance.account,
    pre_mint: balance.preMint ?? null,
    post_mint: balance.postMint ?? null,
    pre_owner: balance.preOwner ?? null,
    post_owner: balance.postOwner ?? null,
    pre_amount: balance.preAmount?.toString() ?? null,
    post_amount: balance.postAmount?.toString() ?? null,
    pre_decimals: balance.preDecimals ?? null,
    post_decimals: balance.postDecimals ?? null,
    pre_program_id: balance.preProgramId ?? null,
    post_program_id: balance.postProgramId ?? null,
  });
}

function instructionRecord(
  at: At,
  instruction: Instruction,
  decoded: DecodedInstruction | null,
): RawRecord {
  assert.ok(instruction.instructionAddress.length > 0);
  return record(`${at.slot}:${at.tx_index}:${instruction.instructionAddress.join(".")}`, {
    kind: "instruction",
    ...at,
    instruction_address: instruction.instructionAddress,
    program_id: instruction.programId,
    accounts: instruction.accounts,
    data: instruction.data,
    is_committed: instruction.isCommitted,
    instruction: decoded?.instruction ?? null,
    args: decoded?.args ?? null,
    named_accounts: decoded?.named_accounts ?? null,
  });
}

const record = (id: string, data: Record<string, unknown>): RawRecord => ({ id, callId: id, data });

import assert from "node:assert/strict";
import { getAddressDecoder, getBase58Encoder } from "@solana/kit";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type Field = "u8" | "u64" | "address" | "optionAddress" | "authorityType";

type Layout = {
  name: string;
  /** Account roles by position. */
  accounts: readonly string[];
  data: readonly (readonly [name: string, field: Field])[];
};

export type DecodedInstruction = {
  instruction: string;
  /** Data fields by name: u64 amounts as decimal strings, an unset option as null. */
  args: Record<string, unknown>;
  named_accounts: Record<string, string>;
};

const amount = ["amount", "u64"] as const;
const decimals = ["decimals", "u8"] as const;
const owner = ["owner", "address"] as const;
const mintAuthorities = [
  decimals,
  ["mintAuthority", "address"],
  ["freezeAuthority", "optionAddress"],
] as const;

// The SPL Token instructions by their first data byte, with the names, account roles and data
// fields of Pipes' tokenProgram ABI (src/solana/abi/tokenProgram in @subsquid/pipes), so the raw
// rows read as that ABI decodes them. Pipes does not export the ABI, and the ABI imports
// @subsquid/borsh, which Pipes does not install. uiAmountToAmount (24) is left out: its data is a
// UTF-8 string with no length, which the ABI misreads as a borsh string.
const LAYOUTS: ReadonlyMap<number, Layout> = new Map<number, Layout>([
  [0, { name: "initializeMint", accounts: ["mint", "rent"], data: mintAuthorities }],
  [1, {
    name: "initializeAccount",
    accounts: ["accountToInitialize", "mint", "owner", "rentSysvar"],
    data: [],
  }],
  [2, {
    name: "initializeMultisig",
    accounts: ["multisig", "rent", "signers"],
    data: [["noOfSignersRequired", "u8"]],
  }],
  [3, {
    name: "transfer",
    accounts: ["source", "destination", "authority", "signers"],
    data: [amount],
  }],
  [4, { name: "approve", accounts: ["source", "delegate", "owner", "signers"], data: [amount] }],
  [5, { name: "revoke", accounts: ["source", "owner", "signers"], data: [] }],
  [6, {
    name: "setAuthority",
    accounts: ["mint", "currentAuthority", "signers"],
    data: [["authorityType", "authorityType"], ["newAuthority", "optionAddress"]],
  }],
  [7, {
    name: "mintTo",
    accounts: ["mint", "mintTo", "mintAuthority", "signers"],
    data: [amount],
  }],
  [8, { name: "burn", accounts: ["burnAccount", "mint", "owner", "signers"], data: [amount] }],
  [9, {
    name: "closeAccount",
    accounts: ["closeAccount", "destination", "owner", "signers"],
    data: [],
  }],
  [10, {
    name: "freezeAccount",
    accounts: ["freezeAccount", "mint", "owner", "signers"],
    data: [],
  }],
  [11, { name: "thawAccount", accounts: ["thawAccount", "mint", "owner", "signers"], data: [] }],
  [12, {
    name: "transferChecked",
    accounts: ["source", "tokenMint", "destination", "owner", "signers"],
    data: [amount, decimals],
  }],
  [13, {
    name: "approveChecked",
    accounts: ["source", "tokenMint", "delegate", "owner", "signers"],
    data: [amount, decimals],
  }],
  [14, {
    name: "mintToChecked",
    accounts: ["tokenMint", "mintTo", "mintAuthority", "signers"],
    data: [amount, decimals],
  }],
  [15, {
    name: "burnChecked",
    accounts: ["burnAccount", "tokenMint", "owner", "signers"],
    data: [amount, decimals],
  }],
  [16, {
    name: "initializeAccount2",
    accounts: ["initializeAccount", "associatedMint", "rentSysvar"],
    data: [owner],
  }],
  [17, { name: "syncNative", accounts: ["nativeTokenAccount"], data: [] }],
  [18, {
    name: "initializeAccount3",
    accounts: ["initializeAccount", "associatedMint"],
    data: [owner],
  }],
  [19, {
    name: "initializeMultisig2",
    accounts: ["initializeAccount", "signers"],
    data: [["m", "u8"]],
  }],
  [20, { name: "initializeMint2", accounts: ["mint"], data: mintAuthorities }],
  [21, { name: "getAccountDataSize", accounts: ["mint"], data: [] }],
  [22, { name: "initializeImmutableOwner", accounts: ["initializeAccount"], data: [] }],
  [23, { name: "amountToUiAmount", accounts: ["mint"], data: [amount] }],
]);

/** The instructions that create a token account. Each names the new account first. */
export const ACCOUNT_INITIALIZERS: ReadonlySet<string> = new Set([
  "initializeAccount",
  "initializeAccount2",
  "initializeAccount3",
]);

// The program's AuthorityType enum, by its byte.
const AUTHORITY_TYPES = ["MintTokens", "FreezeAccount", "AccountOwner", "CloseAccount"] as const;
const ADDRESS_SIZE = 32;

const base58 = getBase58Encoder();
const addresses = getAddressDecoder();

/**
 * The instruction's name, data and account roles, or null when its data is not one of LAYOUTS: an
 * unknown first byte, too few bytes, or an enum or option byte out of range. Bytes past the last
 * field are ignored, as the program itself ignores them.
 */
export function decodeTokenInstruction(
  accounts: readonly string[],
  data: string,
): DecodedInstruction | null {
  const bytes = Uint8Array.from(base58.encode(data));
  const layout = bytes.length > 0 ? LAYOUTS.get(bytes[0]!) : undefined;
  if (layout === undefined) return null;
  const args = readFields(bytes, layout.data);
  if (args === null) return null;
  const named_accounts: Record<string, string> = {};
  layout.accounts.forEach((role, index) => {
    const account = accounts[index];
    if (account !== undefined) named_accounts[role] = account;
  });
  assert.ok(Object.keys(named_accounts).length <= accounts.length);
  return { instruction: layout.name, args, named_accounts };
}

/** The fields after the first byte, in order, or null when the bytes do not hold them. */
function readFields(bytes: Uint8Array, fields: Layout["data"]): Record<string, unknown> | null {
  assert.ok(bytes.length > 0, "the first byte names the instruction");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const args: Record<string, unknown> = {};
  let offset = 1;
  for (const [name, field] of fields) {
    const read = readField(bytes, view, offset, field);
    if (read === null) return null;
    args[name] = read.value;
    offset = read.next;
  }
  assert.ok(offset <= bytes.length);
  return args;
}

function readField(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  field: Field,
): { value: unknown; next: number } | null {
  assert.ok(offset >= 1);
  const left = bytes.length - offset;
  switch (field) {
    case "u8":
      if (left < 1) return null;
      return { value: bytes[offset], next: offset + 1 };
    case "u64":
      if (left < 8) return null;
      return { value: view.getBigUint64(offset, true).toString(), next: offset + 8 };
    case "address":
      if (left < ADDRESS_SIZE) return null;
      return { value: addressAt(bytes, offset), next: offset + ADDRESS_SIZE };
    case "optionAddress": {
      if (left < 1) return null;
      if (bytes[offset] === 0) return { value: null, next: offset + 1 };
      if (bytes[offset] !== 1) return null;
      if (left < 1 + ADDRESS_SIZE) return null;
      return { value: addressAt(bytes, offset + 1), next: offset + 1 + ADDRESS_SIZE };
    }
    case "authorityType": {
      const kind = left >= 1 ? AUTHORITY_TYPES[bytes[offset]!] : undefined;
      return kind === undefined ? null : { value: { kind }, next: offset + 1 };
    }
  }
}

const addressAt = (bytes: Uint8Array, offset: number): string =>
  addresses.decode(bytes.subarray(offset, offset + ADDRESS_SIZE));

// Decoding against byte layouts written out by hand from the SPL Token program's instruction format:
// one byte naming the instruction, then little-endian u64 amounts, u8 decimals, 32-byte addresses,
// and a one-byte tag before an optional address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddressDecoder, getAddressEncoder, getBase58Decoder, type Address } from "@solana/kit";
import { decodeTokenInstruction } from "#src/instructions.ts";

const base58 = getBase58Decoder();
const data = (...bytes: number[]) => base58.decode(Uint8Array.from(bytes));
const addressOf = (n: number): string => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const bytesOf = (address: string) => [...getAddressEncoder().encode(address as Address)];
const source = addressOf(1);
const mint = addressOf(2);
const destination = addressOf(3);
const owner = addressOf(4);
const signer = addressOf(5);
// 0x0807060504030201 read little-endian; a big-endian read would give 0x0102030405060708.
const AMOUNT = [1, 2, 3, 4, 5, 6, 7, 8];

test("transfer and transferChecked give the amount as text and the ABI's account roles", () => {
  assert.deepEqual(decodeTokenInstruction([source, destination, owner], data(3, ...AMOUNT)), {
    instruction: "transfer",
    args: { amount: (0x0807060504030201n).toString() },
    named_accounts: { source, destination, authority: owner },
  });
  assert.deepEqual(
    decodeTokenInstruction([source, mint, destination, owner, signer], data(12, ...Array(8).fill(255), 6)),
    {
      instruction: "transferChecked",
      args: { amount: "18446744073709551615", decimals: 6 },
      named_accounts: { source, tokenMint: mint, destination, owner, signers: signer },
    },
  );
});

test("mints and burns name their token account and mint", () => {
  const cases = [
    [7, "mintTo", { mint, mintTo: destination, mintAuthority: owner }],
    [8, "burn", { burnAccount: destination, mint, owner }],
  ] as const;
  for (const [byte, name, roles] of cases) {
    const accounts = byte === 7 ? [mint, destination, owner] : [destination, mint, owner];
    assert.deepEqual(decodeTokenInstruction(accounts, data(byte, ...AMOUNT)), {
      instruction: name,
      args: { amount: (0x0807060504030201n).toString() },
      named_accounts: roles,
    });
  }
  assert.deepEqual(decodeTokenInstruction([mint, destination, owner], data(14, ...AMOUNT, 6))?.args, {
    amount: (0x0807060504030201n).toString(),
    decimals: 6,
  });
  assert.equal(decodeTokenInstruction([destination, mint, owner], data(15, ...AMOUNT, 6))?.instruction, "burnChecked");
});

test("setAuthority gives the authority type by name and the new authority, or null when it is removed", () => {
  assert.deepEqual(decodeTokenInstruction([source, owner], data(6, 2, 1, ...bytesOf(signer))), {
    instruction: "setAuthority",
    args: { authorityType: { kind: "AccountOwner" }, newAuthority: signer },
    named_accounts: { mint: source, currentAuthority: owner },
  });
  assert.deepEqual(decodeTokenInstruction([source, owner], data(6, 3, 0))?.args, {
    authorityType: { kind: "CloseAccount" },
    newAuthority: null,
  });
});

test("initializeAccount2 and 3 carry the owner in their data, initializeAccount in its accounts", () => {
  assert.deepEqual(decodeTokenInstruction([source, mint], data(18, ...bytesOf(owner))), {
    instruction: "initializeAccount3",
    args: { owner },
    named_accounts: { initializeAccount: source, associatedMint: mint },
  });
  assert.deepEqual(decodeTokenInstruction([source, mint, signer], data(16, ...bytesOf(owner)))?.named_accounts, {
    initializeAccount: source,
    associatedMint: mint,
    rentSysvar: signer,
  });
  assert.deepEqual(decodeTokenInstruction([source, mint, owner, signer], data(1))?.named_accounts, {
    accountToInitialize: source,
    mint,
    owner,
    rentSysvar: signer,
  });
});

test("data the layouts do not hold decodes to null, and bytes past the last field are ignored", () => {
  assert.equal(decodeTokenInstruction([source], ""), null, "no bytes");
  assert.equal(decodeTokenInstruction([source], data(24, 49)), null, "uiAmountToAmount is left out");
  assert.equal(decodeTokenInstruction([source], data(200)), null, "no such instruction");
  assert.equal(decodeTokenInstruction([source, destination, owner], data(3, 1, 2, 3)), null, "short amount");
  assert.equal(decodeTokenInstruction([source, owner], data(6, 4, 0)), null, "no such authority type");
  assert.equal(decodeTokenInstruction([source, owner], data(6, 2, 2)), null, "no such option tag");
  assert.equal(decodeTokenInstruction([source, owner], data(6, 2, 1, 9)), null, "short new authority");
  assert.deepEqual(decodeTokenInstruction([source, destination, owner], data(3, ...AMOUNT, 99))?.args, {
    amount: (0x0807060504030201n).toString(),
  });
});

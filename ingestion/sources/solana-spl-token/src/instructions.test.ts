// Decoding against byte layouts written out by hand from the SPL Token instruction format: one
// byte naming the instruction, then little-endian u64 amounts, u8 decimals, 32-byte addresses, and
// a one-byte tag before an optional address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddressDecoder, getAddressEncoder, getBase58Decoder, type Address } from "@solana/kit";
import { decodeTokenInstruction as decode } from "#src/instructions.ts";

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
const AMOUNT_TEXT = (0x0807060504030201n).toString();

test("transfer and transferChecked give the amount as text and the ABI's account roles", () => {
  assert.deepEqual(decode([source, destination, owner], data(3, ...AMOUNT)), {
    instruction: "transfer",
    args: { amount: AMOUNT_TEXT },
    named_accounts: { source, destination, authority: owner },
  });
  const most = Array(8).fill(255);
  assert.deepEqual(decode([source, mint, destination, owner, signer], data(12, ...most, 6)), {
    instruction: "transferChecked",
    args: { amount: "18446744073709551615", decimals: 6 },
    named_accounts: { source, tokenMint: mint, destination, owner, signers: signer },
  });
});

test("mints and burns name their token account and mint", () => {
  assert.deepEqual(decode([mint, destination, owner], data(7, ...AMOUNT)), {
    instruction: "mintTo",
    args: { amount: AMOUNT_TEXT },
    named_accounts: { mint, mintTo: destination, mintAuthority: owner },
  });
  assert.deepEqual(decode([destination, mint, owner], data(8, ...AMOUNT)), {
    instruction: "burn",
    args: { amount: AMOUNT_TEXT },
    named_accounts: { burnAccount: destination, mint, owner },
  });
  const minted = decode([mint, destination, owner], data(14, ...AMOUNT, 6));
  assert.deepEqual(minted?.args, { amount: AMOUNT_TEXT, decimals: 6 });
  assert.deepEqual(minted?.named_accounts, {
    tokenMint: mint,
    mintTo: destination,
    mintAuthority: owner,
  });
  const burned = decode([destination, mint, owner], data(15, ...AMOUNT, 6));
  assert.deepEqual(burned?.named_accounts, { burnAccount: destination, tokenMint: mint, owner });
});

test("setAuthority gives the authority type by name, and the new one or null", () => {
  assert.deepEqual(decode([source, owner], data(6, 2, 1, ...bytesOf(signer))), {
    instruction: "setAuthority",
    args: { authorityType: { kind: "AccountOwner" }, newAuthority: signer },
    named_accounts: { mint: source, currentAuthority: owner },
  });
  assert.deepEqual(decode([source, owner], data(6, 3, 0))?.args, {
    authorityType: { kind: "CloseAccount" },
    newAuthority: null,
  });
});

test("initializeAccount2 and 3 carry the owner in data, initializeAccount in accounts", () => {
  assert.deepEqual(decode([source, mint], data(18, ...bytesOf(owner))), {
    instruction: "initializeAccount3",
    args: { owner },
    named_accounts: { initializeAccount: source, associatedMint: mint },
  });
  assert.deepEqual(decode([source, mint, signer], data(16, ...bytesOf(owner)))?.named_accounts, {
    initializeAccount: source,
    associatedMint: mint,
    rentSysvar: signer,
  });
  assert.deepEqual(decode([source, mint, owner, signer], data(1))?.named_accounts, {
    accountToInitialize: source,
    mint,
    owner,
    rentSysvar: signer,
  });
});

test("data the layouts do not hold decodes to null; bytes past the last field are ignored", () => {
  const accounts = [source, destination, owner];
  assert.equal(decode(accounts, ""), null, "no bytes");
  assert.equal(decode(accounts, data(24, 49)), null, "uiAmountToAmount is left out");
  assert.equal(decode(accounts, data(200)), null, "no such instruction");
  assert.equal(decode(accounts, data(3, 1, 2, 3)), null, "short amount");
  assert.equal(decode(accounts, data(6, 4, 0)), null, "no such authority type");
  assert.equal(decode(accounts, data(6, 2, 2)), null, "no such option tag");
  assert.equal(decode(accounts, data(6, 2, 1, 9)), null, "short new authority");
  assert.deepEqual(decode(accounts, data(3, ...AMOUNT, 99))?.args, { amount: AMOUNT_TEXT });
});

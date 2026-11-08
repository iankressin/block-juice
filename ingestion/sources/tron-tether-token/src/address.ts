import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/**
 * A TRON address in Base58Check: base58 of the 0x41 prefix, the 20-byte account, and the first four
 * bytes of sha256(sha256(prefix + account)). Base58 is case-sensitive, so it is kept as written.
 */
export type TronAddress = string & { readonly __brand: "TronAddress" };

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PREFIX = 0x41;
const ACCOUNT_BYTES = 20;
const PAYLOAD_BYTES = 1 + ACCOUNT_BYTES;
const CHECKSUM_BYTES = 4;
const ADDRESS_BYTES = PAYLOAD_BYTES + CHECKSUM_BYTES;
// 25 bytes with a non-zero first byte take 34 base58 digits; a few more leave room to reject junk.
const ADDRESS_CHARS_MAX = 40;
const HEX_ACCOUNT = /^[0-9a-fA-F]{40}$/;

const checksum = (payload: Uint8Array): Uint8Array => {
  assert.equal(payload.length, PAYLOAD_BYTES);
  const once = createHash("sha256").update(payload).digest();
  return createHash("sha256").update(once).digest().subarray(0, CHECKSUM_BYTES);
};

function base58Encode(bytes: Uint8Array): string {
  assert.equal(bytes.length, ADDRESS_BYTES);
  assert.equal(bytes[0], PREFIX, "a TRON address never starts with a zero byte");
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let text = "";
  for (let i = 0; i < ADDRESS_CHARS_MAX && value > 0n; i++) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  assert.equal(value, 0n);
  return text;
}

/** The 25 bytes a Base58 text spells, or null when it is not base58 or does not fit. */
function base58Decode(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > ADDRESS_CHARS_MAX) return null;
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16).padStart(ADDRESS_BYTES * 2, "0");
  if (hex.length !== ADDRESS_BYTES * 2) return null;
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** The Base58Check address of a 20-byte account, as Portal writes it in logs: hex without 0x. */
export function tronAddressFromHex(account: string): TronAddress {
  assert.match(account, HEX_ACCOUNT, `Expected 20 bytes of hex, got ${account}`);
  const payload = Uint8Array.from([PREFIX, ...Buffer.from(account, "hex")]);
  const address = base58Encode(Uint8Array.from([...payload, ...checksum(payload)]));
  assert.ok(address.startsWith("T"));
  return address as TronAddress;
}

/** The Base58Check address of a 41-prefixed account, as TRON transactions name their owner. */
export function tronAddressFromPrefixedHex(prefixed: string): TronAddress {
  assert.ok(prefixed.startsWith("41"), `Expected a 41-prefixed TRON account, got ${prefixed}`);
  return tronAddressFromHex(prefixed.slice(2));
}

/** The address when `text` is a Base58Check TRON address in its canonical spelling, else null. */
export function parseTronAddress(text: string): TronAddress | null {
  const bytes = base58Decode(text);
  if (bytes === null || bytes[0] !== PREFIX) return null;
  const payload = bytes.subarray(0, PAYLOAD_BYTES);
  if (!Buffer.from(checksum(payload)).equals(bytes.subarray(PAYLOAD_BYTES))) return null;
  if (base58Encode(bytes) !== text) return null;
  return text as TronAddress;
}

/** The 20-byte account of an address in lower-case hex without 0x, as Portal's filter takes it. */
export function tronAddressToHex(address: TronAddress): string {
  const bytes = base58Decode(address);
  assert.ok(bytes !== null && bytes[0] === PREFIX, `${address} is not a TRON address`);
  const account = Buffer.from(bytes.subarray(1, PAYLOAD_BYTES)).toString("hex");
  assert.equal(tronAddressFromHex(account), address, "hex and Base58 round-trip");
  return account;
}

/** Every entry when all are Base58Check TRON addresses, else an error that lists the bad ones. */
export function validateTronAddressList(entries: readonly unknown[]): TronAddress[] {
  const invalid = entries.filter((entry) => typeof entry !== "string" || !parseTronAddress(entry));
  if (invalid.length > 0) {
    const lines = invalid.map((entry) => `  ${String(entry)}`);
    throw new Error(`Invalid TRON addresses:\n${lines.join("\n")}`);
  }
  return entries as TronAddress[];
}

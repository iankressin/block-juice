import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTronAddress,
  tronAddressFromHex,
  tronAddressFromPrefixedHex,
  tronAddressToHex,
  validateTronAddressList,
} from "#src/address.ts";

// The USDT contract, the owner multisig that emits logs next to it, and the account that deployed
// the multisig. TronGrid's wallet/getcontract names each in both forms (with and without visible).
const PAIRS = [
  ["a614f803b6fd780986a42c78ec9c7f77e6ded13c", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"],
  ["0fa695d6b065707cb4e0ef73b751c93347682bf2", "TBPxhVAsuzoFnKyXtc1o2UySEydPHgATto"],
  ["6f113b919b670f3579e4f680830d9709baf52ac0", "TL6Uehakg6iZDcU6ggaQDcp4oVVJpkU36a"],
] as const;
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

test("hex becomes Base58Check and Base58Check becomes the same hex", () => {
  for (const [hex, base58] of PAIRS) {
    assert.equal(tronAddressFromHex(hex), base58);
    assert.equal(tronAddressFromHex(hex.toUpperCase()), base58, "hex case leaves the bytes alone");
    assert.equal(tronAddressFromPrefixedHex(`41${hex}`), base58);
    assert.equal(tronAddressToHex(parseTronAddress(base58)!), hex);
  }
});

test("a mixed-case address is kept byte for byte, and its lower-case spelling is none", () => {
  assert.equal(parseTronAddress(USDT), USDT);
  assert.notEqual(USDT.toLowerCase(), USDT);
  assert.equal(parseTronAddress(USDT.toLowerCase()), null);
});

test("a bad checksum, a foreign prefix or a non-base58 character is no TRON address", () => {
  assert.equal(parseTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u"), null, "last digit changed");
  assert.equal(parseTronAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"), null, "Bitcoin's 0x00");
  assert.equal(parseTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj60"), null, "0 is not base58");
  assert.equal(parseTronAddress("0xa614f803b6fd780986a42c78ec9c7f77e6ded13c"), null);
  assert.equal(parseTronAddress(""), null);
});

test("an address list with a bad entry names every bad entry", () => {
  assert.deepEqual(validateTronAddressList([USDT]), [USDT]);
  assert.throws(() => validateTronAddressList([USDT, "tr7nhq", 7]), {
    message: "Invalid TRON addresses:\n  tr7nhq\n  7",
  });
});

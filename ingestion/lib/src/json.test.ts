import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { captureJsonReads, readJson } from "#src/json.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "json-inputs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("call inputs fingerprint the bytes read by lazy iterators, without retaining mutable values", async (t) => {
  const path = join(fixture(t), "wallets.json");
  const original = '{"wallets":["private-wallet"]}\n';
  writeFileSync(path, original);
  async function* extract() {
    await Promise.resolve();
    const value = readJson(path);
    value.wallets.push("mutated-by-source");
    yield value;
    writeFileSync(path, '["second-version"]');
    readJson(path);
    readJson(path);
    writeFileSync(path, '["never-read"]');
  }
  const result = await captureJsonReads(async () => {
    for await (const _value of extract()) { /* Consume inside the run's capture context. */ }
  }, false);
  assert.deepEqual({ ...result.inputs }, {});
  assert.deepEqual({ ...result.files.files }, { [path]: [
    { sha256: sha256(original), bytes: Buffer.byteLength(original) },
    { sha256: sha256('["second-version"]'), bytes: 18 },
  ] });
  assert.equal(result.files.truncated, false);
  assert.equal(JSON.stringify(result).includes("private-wallet"), false);
});

test("custom input names do not collide with object prototypes", async (t) => {
  const dir = fixture(t);
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(dir);
  writeFileSync("__proto__", '["one"]');
  writeFileSync("constructor", '["two"]');
  const result = await captureJsonReads(async () => { readJson("__proto__"); readJson("constructor"); });
  assert.deepEqual(Object.keys(result.files.files), ["__proto__", "constructor"]);
  assert.deepEqual(Object.keys(result.inputs), ["__proto__", "constructor"]);
});

test("concurrent runs keep independent JSON evidence", async (t) => {
  const dir = fixture(t);
  const paths = [join(dir, "one.json"), join(dir, "two.json")];
  paths.forEach((path, i) => writeFileSync(path, String(i)));
  const results = await Promise.all(paths.map((path) => captureJsonReads(async () => {
    await Promise.resolve();
    readJson(path);
    await Promise.resolve();
    readJson(path);
  }, false)));
  assert.deepEqual(results.map((result) => Object.keys(result.files.files)), paths.map((path) => [path]));
});

test("custom-source file counts and changing versions are bounded with explicit incomplete evidence", async (t) => {
  const dir = fixture(t);
  const result = await captureJsonReads(async () => {
    for (let file = 0; file < 130; file++) {
      const path = join(dir, `${file}.json`);
      for (let version = 0; version < (file === 0 ? 18 : 1); version++) {
        writeFileSync(path, String(version));
        readJson(path);
      }
    }
  }, false);
  assert.equal(Object.keys(result.files.files).length, 128);
  assert.equal(result.files.files[join(dir, "0.json")]?.length, 16);
  assert.equal(result.files.truncated, true);
});

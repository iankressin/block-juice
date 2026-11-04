import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const env = { ERPC_URL: "http://127.0.0.1:1" };

/** This package's source, imported from a copy of the package whose addresses.json holds `json`. */
async function sourceWith(t: TestContext, json: string) {
  const dir = await mkdtemp(join(tmpdir(), "solana-sol-balances-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "addresses.json"), json);
  const copy: typeof import("#src/source.ts") = await import(
    pathToFileURL(join(dir, "src", "source.ts")).href
  );
  return copy.solanaSolBalances;
}

const firstBatch = (source: Awaited<ReturnType<typeof sourceWith>>) =>
  source.extract(env, [])[Symbol.asyncIterator]().next();

test("a bad address in addresses.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, JSON.stringify({ wallets: ["not-an-address"] }));
  await assert.rejects(firstBatch(source), {
    message: "Invalid Solana addresses:\n  not-an-address",
  });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, '{ "wallets": [], }');
  await assert.rejects(firstBatch(source), /addresses\.json/);
});

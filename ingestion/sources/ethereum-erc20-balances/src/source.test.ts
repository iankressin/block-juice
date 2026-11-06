import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const env = { BLOCK_NUMBER: "latest", EVM_RPC_URL: "http://127.0.0.1:1", RPC_BATCH_SIZE: 1, RPC_MAX_CONCURRENCY: 1 } as const;

/** This package's source, imported from a copy of the package whose addresses.json holds `json`. */
async function sourceWith(t: TestContext, json: string) {
  const dir = await mkdtemp(join(tmpdir(), "ethereum-erc20-balances-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "addresses.json"), json);
  const copy: typeof import("#src/source.ts") = await import(
    pathToFileURL(join(dir, "src", "source.ts")).href
  );
  return copy.ethereumErc20Balances;
}

const firstBatch = (source: Awaited<ReturnType<typeof sourceWith>>) =>
  source.extract(env, [])[Symbol.asyncIterator]().next();

test("a bad address in addresses.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, JSON.stringify({ wallets: ["0xnot-an-address"], tokens: [] }));
  await assert.rejects(firstBatch(source), {
    message: "Invalid Ethereum addresses:\n  0xnot-an-address",
  });
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, '{ "wallets": [], }');
  await assert.rejects(firstBatch(source), /addresses\.json/);
});

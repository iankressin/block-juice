import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { forChain } from "#src/source.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const env = { BLOCK_NUMBER: "latest", EVM_RPC_URL: "http://127.0.0.1:1", RPC_BATCH_SIZE: 1, RPC_MAX_CONCURRENCY: 1 } as const;

/** This package's Ethereum source, imported from a copy of the package whose chains/ethereum/addresses.json holds `json`. */
async function sourceWith(t: TestContext, json: string) {
  const dir = await mkdtemp(join(tmpdir(), "evm-erc20-balances-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await mkdir(join(dir, "chains", "ethereum"), { recursive: true });
  await writeFile(join(dir, "chains", "ethereum", "addresses.json"), json);
  const copy: typeof import("#src/source.ts") = await import(
    pathToFileURL(join(dir, "src", "source.ts")).href
  );
  return copy.forChain("ethereum");
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

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("ethereum").name, "ethereum", "runSource writes to raw.ethereum_erc20_balances");
  assert.equal(forChain("ethereum").table, "erc20_balances");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
});

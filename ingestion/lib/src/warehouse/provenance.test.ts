import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { factoryCachePath } from "#src/factory-cache.ts";
import { streamProvenance, recordCoverage } from "#src/warehouse/provenance.ts";
import { captureJsonReads, readJson } from "#src/json.ts";
import { pgliteWarehouse } from "#src/warehouse/pglite.fixture.ts";
import { runSource } from "#src/run/index.ts";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import * as z from "zod";
import { forChain } from "../../../sources/evm-uniswap-v3/src/source.ts";
import factoryAbi from "../../../../catalog/protocols/uniswap/abis/v3-factory.json" with { type: "json" };
import poolAbi from "../../../../catalog/protocols/uniswap/abis/v3-pool.json" with { type: "json" };

test("provenance captures consumed inputs before edits and never persists credentials", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "provenance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "addresses.json");
  writeFileSync(path, '{"tokens":["0xAa"]}');
  const { inputs } = await captureJsonReads(async () => {
    const value = readJson(path);
    value.tokens.push("modified-by-consumer");
    writeFileSync(path, '{"tokens":["later-file-edit"]}');
  });
  const config = streamProvenance({ name: "ethereum", table: "events", coverage: { unrestricted: [] } },
    { START_BLOCK: 1, PORTAL_URL: "https://provider/secret", PORTAL_API_KEY: "secret", END_BLOCK: 100 }, inputs);
  assert.deepEqual(config!.filter, { tokens: ["0xaa"] });
  assert.equal(JSON.stringify(config).includes("secret"), false);
  assert.equal(JSON.stringify(config).includes("END_BLOCK"), false, "run caps do not create new datasets");
});

test("factory histories preserve the original file and use stable independent paths after changes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-identity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "factory.sqlite");
  writeFileSync(path, "legacy cache remains");
  const settings = { START_BLOCK: 100, POOLS_START_BLOCK: 1, PORTAL_URL: "https://provider/secret" };
  assert.equal(factoryCachePath(path, settings, { tokens: ["a"] }), path);
  const changed = factoryCachePath(path, settings, { tokens: ["a", "b"] });
  assert.notEqual(changed, path);
  assert.equal(factoryCachePath(path, settings, { tokens: ["b", "a"] }), changed);
  assert.equal(factoryCachePath(path, settings, { tokens: ["b", "a", "a"] }), changed);
  assert.equal(factoryCachePath(path, settings, { tokens: ["a"] }), path);
  assert.equal(readFileSync(path, "utf8"), "legacy cache remains");
  assert.equal(readFileSync(`${path}.identity`, "utf8").includes("secret"), false);
});

test("factory coverage needs evidenced pool history, including batches before the swap start", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  await warehouse.open("ethereum_events");
  const q = { query: <R>(sql: string, params?: unknown[]) => db.query<R>(sql, params) };
  const config = streamProvenance({ name: "ethereum", table: "events", coverage: { unrestricted: [] } },
    { START_BLOCK: 100, POOLS_START_BLOCK: 1, PORTAL_URL: "https://provider" }, {})!;
  await recordCoverage(q, '"raw"', "ethereum_events", config, 1, 50, true);
  await recordCoverage(q, '"raw"', "ethereum_events", config, 51, 120, false);
  assert.deepEqual((await db.query("select from_block, to_block, verified from raw._coverage")).rows,
    [{ from_block: 1, to_block: 120, verified: true }]);
  await db.query("delete from raw._coverage");
  await recordCoverage(q, '"raw"', "ethereum_events", config, 121, 130, false);
  assert.deepEqual((await db.query("select verified from raw._coverage")).rows, [{ verified: false }]);
});

test("adding a Uniswap token backfills its old pool and swaps while retaining the original generation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-backfill-"));
  const cwd = process.cwd();
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(join(dir, "chains/ethereum"), { recursive: true });
  process.chdir(dir);
  const addresses = join(dir, "chains/ethereum/addresses.json");
  const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
  const [oldToken, newToken, quote, oldPool, newPool] = [1, 2, 3, 4, 5].map(address) as [Hex, Hex, Hex, Hex, Hex];
  const created = (token: Hex, pool: Hex) => encodeEvent({
    abi: factoryAbi as Abi, eventName: "PoolCreated", address: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
    args: { token0: token, token1: quote, fee: 3000, tickSpacing: 60, pool },
  } as Parameters<typeof encodeEvent>[0]);
  const swap = (pool: Hex) => encodeEvent({ abi: poolAbi as Abi, eventName: "Swap", address: pool,
    args: { sender: quote, recipient: quote, amount0: 1n, amount1: -1n, sqrtPriceX96: 1n, liquidity: 1n, tick: 0 },
  } as Parameters<typeof encodeEvent>[0]);
  const portal = await mockPortal({ blocks: [
    mockBlock({ number: 1, transactions: [{ from: quote, logs: [created(oldToken, oldPool), created(newToken, newPool)] }] }),
    mockBlock({ number: 2, transactions: [{ from: quote, logs: [swap(oldPool), swap(newPool)] }] }),
  ] });
  t.after(() => portal.close());
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = forChain("ethereum");
  source.env = z.object({}).transform(() => ({
    PORTAL_URL: portal.url, START_BLOCK: 2, POOLS_START_BLOCK: 1, FACTORY_DB: join(dir, "factory.sqlite"),
  }));
  writeFileSync(addresses, JSON.stringify({ tokens: [oldToken] }));
  await runSource(source, warehouse);
  assert.equal(process.exitCode, undefined);
  const swaps = async () => (await db.query<{ contract: string }>(
    "select data->>'contract' as contract from raw.ethereum_uniswap_v3 where data->>'event' = 'Swap' order by contract"
  )).rows.map((row) => row.contract);
  assert.deepEqual(await swaps(), [oldPool]);
  writeFileSync(addresses, JSON.stringify({ tokens: [oldToken, newToken] }));
  await runSource(source, warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await swaps(), [oldPool, newPool], "the new pool was created before the swap window");
  const states = await db.query("select distinct id from raw._sync");
  assert.equal(states.rows.length, 2);
  assert.deepEqual((await db.query("select distinct verified from raw._coverage")).rows, [{ verified: true }]);
});

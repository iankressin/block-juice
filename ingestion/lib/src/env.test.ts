import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import * as z from "zod";
import { loadEnv } from "#src/env.ts";

const KEYS = ["CHAIN", "ENV_TEST_A", "ENV_TEST_B", "ENV_TEST_C", "ENV_TEST_D"] as const;
const schema = z.object(Object.fromEntries(KEYS.map((key) => [key, z.string().optional()])));

/** A package folder holding `files`, by path from the folder. Returns its path. */
async function packageWith(t: TestContext, files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "load-env-"));
  t.after(() => rm(dir, { recursive: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

/** loadEnv run from `dir` with `environment` as the only test keys set, as a source runs from its package. */
function loadFrom(t: TestContext, dir: string, environment: Partial<Record<(typeof KEYS)[number], string>>) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  const cwd = process.cwd();
  t.after(() => {
    process.chdir(cwd);
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, environment);
  process.chdir(dir);
  return loadEnv(schema);
}

const files = {
  ".env": "ENV_TEST_A=package\nENV_TEST_B=package\nENV_TEST_C=package\nENV_TEST_D=package\n",
  "chains/base/.env.example": "ENV_TEST_A=example\nENV_TEST_B=example\nENV_TEST_D=example\n",
  "chains/base/.env": "ENV_TEST_A=chain\n",
};

test("the environment wins, then the chain's .env, its .env.example, and the package's .env", async (t) => {
  const env = loadFrom(t, await packageWith(t, files), { CHAIN: "base", ENV_TEST_D: "environment" });
  assert.deepEqual(env, {
    CHAIN: "base",
    ENV_TEST_A: "chain",
    ENV_TEST_B: "example",
    ENV_TEST_C: "package",
    ENV_TEST_D: "environment",
  });
});

test("without CHAIN only the package's .env loads, and a CHAIN it sets is dropped", async (t) => {
  const dir = await packageWith(t, { ...files, ".env": "CHAIN=base\nENV_TEST_A=package\n" });
  const env = loadFrom(t, dir, {});
  assert.deepEqual(env, { ENV_TEST_A: "package" });
  assert.equal(process.env.CHAIN, undefined);
});

test("importing the lib, which reads LOG_LEVEL, still lets the chain's settings win over the package's", async (t) => {
  const dir = await packageWith(t, files);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      `import ${JSON.stringify(import.meta.resolve("#src/index.ts"))}; console.log(process.env.ENV_TEST_A);`,
    ],
    { cwd: dir, env: { ...process.env, CHAIN: "base", LOG_LEVEL: "silent" }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "chain");
});

test("local proxy URLs follow root ports while explicit providers win", async (t) => {
  const dir = await packageWith(t, {
    "ingestion/sources.json": "[]",
    ".env": "ERPC_PORT=4444\nDSHACKLE_PORT=9555\n",
    "ingestion/sources/example/chains/base/.env.example": "EVM_RPC_URL=\n",
  });
  const args = ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval",
    `import { loadEnv } from ${JSON.stringify(import.meta.resolve("#src/env.ts"))};
     import * as z from ${JSON.stringify(import.meta.resolve("zod"))};
     console.log(JSON.stringify(loadEnv(z.object({EVM_RPC_URL:z.url(),DSHACKLE_URL:z.url()}))));`];
  const child = spawnSync(process.execPath, args,
    { cwd: join(dir, "ingestion/sources/example"), env: { PATH: process.env.PATH, CHAIN: "base" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    EVM_RPC_URL: "http://localhost:4444/main/evm/8453", DSHACKLE_URL: "http://localhost:9555/bitcoin",
  });
  const explicit = spawnSync(process.execPath, args,
    { cwd: join(dir, "ingestion/sources/example"), env: { PATH: process.env.PATH, CHAIN: "base",
      EVM_RPC_URL: "https://remote.example/rpc", ERPC_PORT: "invalid-unused-port" }, encoding: "utf8" });
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(JSON.parse(explicit.stdout).EVM_RPC_URL, "https://remote.example/rpc");
});

test("direct ingestion retains source-local settings even when a repository root .env differs", async (t) => {
  const dir = await packageWith(t, {
    "ingestion/sources.json": "[]", ".env": "ENV_TEST_A=root\n",
    "ingestion/sources/example/chains/base/.env.example": "ENV_TEST_A=source\n",
  });
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval",
    `import { loadEnv } from ${JSON.stringify(import.meta.resolve("#src/env.ts"))};
     import * as z from ${JSON.stringify(import.meta.resolve("zod"))};
     console.log(loadEnv(z.object({ENV_TEST_A:z.string()})).ENV_TEST_A);`],
    { cwd: join(dir, "ingestion/sources/example"), env: { PATH: process.env.PATH, CHAIN: "base" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "source");
});

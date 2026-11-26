import { config, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

const SCOPE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Reads the env files in the working directory, then validates process.env. An empty value counts
 * as unset. A value already in the environment wins over every file. In a package that loads several
 * chains, the folder of the chain in CHAIN comes next, chains/<CHAIN>/.env and then its .env.example,
 * and the package's .env last. SOURCE_SCOPE, when set, puts the scope's .env and .env.example in
 * that folder's scopes/<SOURCE_SCOPE>/ ahead of those. Only the environment sets CHAIN and
 * SOURCE_SCOPE: a value in a file is dropped, so a stale one cannot point a run at another chain's
 * table or another scope's settings.
 */
export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const chain = process.env.CHAIN;
  const scope = scopeName();
  const folder = chainFolder(chain);
  const chainFiles = chain && folder !== "." ? [`${folder}/.env`, `${folder}/.env.example`] : [];
  const scopeFiles = scope ? [`${scopeFolder(folder, scope)}/.env`, `${scopeFolder(folder, scope)}/.env.example`] : [];
  config({ path: [...scopeFiles, ...chainFiles, ".env"], quiet: true, override: false, fast: false });
  if (chain === undefined) delete process.env.CHAIN;
  if (scope === undefined) delete process.env.SOURCE_SCOPE;
  const values = Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== ""),
  );
  if (schema instanceof z.ZodObject) {
    localEndpoints(values, chain, { evm: "EVM_RPC_URL" in schema.shape, bitcoin: "DSHACKLE_URL" in schema.shape });
  }
  const result = schema.safeParse(values);
  if (!result.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** The scope in SOURCE_SCOPE. The name reaches a file path, so a malformed one fails before any read. */
function scopeName(): string | undefined {
  const scope = process.env.SOURCE_SCOPE;
  if (scope === undefined || scope === "") return undefined;
  if (!SCOPE_NAME.test(scope)) throw new Error(`SOURCE_SCOPE must be a scope name such as mexc-2026-11, not ${scope}`);
  return scope;
}

/**
 * chains/<chain> in a package that loads several chains, else the package's folder. Dagster sets
 * CHAIN for every source, so a package with no chains/ folder must not read one.
 */
function chainFolder(chain?: string): string {
  return chain && existsSync(join("chains", chain)) ? `chains/${chain}` : ".";
}

/** A scope's folder inside `base`, the one rule loadEnv and settingsFolder share. */
function scopeFolder(base: string, scope: string): string {
  return base === "." ? join("scopes", scope) : join(base, "scopes", scope);
}

/**
 * The folder that holds a source's addresses.json: chains/<chain>, or the working directory when
 * `chain` is unset, and that folder's scopes/<SOURCE_SCOPE> when the variable is set.
 */
export function settingsFolder(chain?: string): string {
  const base = chainFolder(chain);
  const scope = scopeName();
  if (!scope) return base;
  const folder = scopeFolder(base, scope);
  if (!existsSync(join(folder, "addresses.json"))) {
    throw new Error(`SOURCE_SCOPE=${scope}: ${folder}/addresses.json does not exist`);
  }
  return folder;
}

function repositoryRoot(): string | undefined {
  let root = process.cwd();
  while (dirname(root) !== root && !existsSync(join(root, "ingestion", "sources.json"))) root = dirname(root);
  return existsSync(join(root, "ingestion", "sources.json")) ? root : undefined;
}

/** Empty/absent URLs opt into the local proxies. Explicit URLs always win, including remote RPCs. */
export function localEndpoints(
  values: Record<string, string | undefined>, chain?: string,
  required = { evm: true, bitcoin: true },
): void {
  if ((!required.evm || values.EVM_RPC_URL) && (!required.bitcoin || values.DSHACKLE_URL)) return;
  const root = repositoryRoot();
  const file = root && join(root, ".env");
  const defaults = file && existsSync(file) ? parse(readFileSync(file)) : {};
  const port = (key: string, fallback: number) => {
    const value = values[key] ?? (process.env[key] === "" ? "" : defaults[key]);
    if (!value) return fallback;
    if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
      throw new Error(`${key} must be a port number between 1 and 65535`);
    }
    return Number(value);
  };
  const chainId: Record<string, number> = { ethereum: 1, arbitrum: 42161, base: 8453, polygon: 137 };
  if (required.evm && !values.EVM_RPC_URL && chain && chainId[chain]) {
    values.EVM_RPC_URL = `http://localhost:${port("ERPC_PORT", 4000)}/main/evm/${chainId[chain]}`;
  }
  if (required.bitcoin && !values.DSHACKLE_URL) values.DSHACKLE_URL = `http://localhost:${port("DSHACKLE_PORT", 8545)}/bitcoin`;
}

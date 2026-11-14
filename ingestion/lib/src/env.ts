import { config, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

/**
 * Reads the env files in the working directory, then validates process.env. An empty value counts
 * as unset. A value already in the environment wins over every file. In a package that loads several
 * chains, the folder of the chain in CHAIN comes next, chains/<CHAIN>/.env and then its .env.example,
 * and the package's .env last. Only the environment sets CHAIN: a CHAIN in a file is dropped, so a
 * stale one cannot point a run at another chain's table.
 */
export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const chain = process.env.CHAIN;
  const chainFiles = chain ? [`chains/${chain}/.env`, `chains/${chain}/.env.example`] : [];
  config({ path: [...chainFiles, ".env"], quiet: true, override: false, fast: false });
  if (chain === undefined) delete process.env.CHAIN;
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

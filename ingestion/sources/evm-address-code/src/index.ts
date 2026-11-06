import { runSource } from "@ingestion/lib";
import { config } from "dotenv";
import { forChain, chainName } from "#src/source.ts";

// Dagster sets CHAIN to the chain of the asset it runs; by hand, run `CHAIN=arbitrum pnpm ingest`.
// It is read before any .env, so a stale CHAIN in a file cannot point a run at the wrong table.
const chain = chainName.parse(process.env.CHAIN);

// The chain's own settings load first, so they win over the shared .env that runSource reads next.
// A value already in the environment wins over both.
config({ path: [`chains/${chain}/.env`, `chains/${chain}/.env.example`], quiet: true });

await runSource(forChain(chain));

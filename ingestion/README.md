# Ingestion

## Overview

The TypeScript pnpm workspace (`pnpm-workspace.yaml`) that extracts chain and exchange data and loads it raw into Postgres. Sources extract and load only; joins, units, prices and sign rules belong in dbt. `sources.json` lists every source as `{ name, table, package, settings?, coverage? }`, and Dagster makes one asset per entry from it. `patches/` holds a pnpm patch for `@subsquid/pipes`. The root `package.json` requires Node 24 or later and depends on `better-sqlite3`, which keeps the factory store of the `evm-uniswap-*` sources, and `pnpm-workspace.yaml` lets only `better-sqlite3` run its install script.

## Subdirectories & Boundaries

- lib: [./lib/README.md](./lib/README.md) - `@ingestion/lib`: the `Source` and `StreamSource` contract, `runSource`, the Postgres warehouse writer, the Portal client, env loading and the EVM, Solana and Bitcoin clients.
- sources: [./sources/README.md](./sources/README.md) - One package per source, each loading `raw.<name>_<table>`.
- scripts: [./scripts/README.md](./scripts/README.md) - `generate-sources-json.ts`, which writes `sources.json` (`pnpm -C ingestion generate-sources`), and an upsert benchmark.

## Global Invariants

- `sources.json` is generated. Run `pnpm -C ingestion generate-sources` after adding or renaming a source; `orchestration/tests/test_sources_json.py` fails while it is stale.
- A source's `name` and `table` equal its dbt source and table, so Dagster links the ingestion asset `[<name>, <table>]` to the staging model.
- A source reads only its own inputs (`addresses.json`, `tokens.json`, its `.env`), any ABI it imports from `catalog/protocols/`, and the chain or vendor. It never reads another source's raw table or a dbt model.
- The `evm-uniswap-*` sources also read and write a factory store at `FACTORY_DB` and its `.identity` sidecar (`lib/src/factory-cache.ts:factoryCachePath`). When `EVM_RPC_URL` or `DSHACKLE_URL` is unset, `loadEnv` reads `ERPC_PORT` or `DSHACKLE_PORT` from the repo-root `.env` (`lib/src/env.ts:localEndpoints`).

## Verification

- Typecheck every package: `pnpm -C ingestion typecheck`.
- One package: `pnpm -C ingestion --filter @ingestion/<package> test`. All of them, which takes minutes: `pnpm -C ingestion -r --workspace-concurrency=1 test`.

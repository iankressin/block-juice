# Ingestion

TypeScript sources that extract chain data and load it raw. To add one, copy the closest source with `uv run --project orchestration bj new-source <source> <table> --like <package>`. It scaffolds the package and the staging stub and regenerates `sources.json`; `docs/architecture.md#add-a-source` covers the rest.

## What a source may do

- A source decides only what to fetch: the block range, the contracts, the events, filters on indexed parameters, and the children a factory creates. It never joins, applies sign rules, converts units, prices or aggregates.
- A source reads only its own `.env`, its `addresses.json` and the chain. It never reads another source's raw table or a dbt model. Adding a source never changes `lib/`, `runSource` or the Source contract, and a source's inputs stay in the source.
- Key each record by its place on chain, such as `<block>:<logIndex>` for a log, so a rerun writes the same row. A log's transaction is a record of its own, with `kind: "transaction"` and id `tx:<hash>`, and dbt joins the two.
- A source's `name` and `table` must equal its dbt source and table names, since Dagster links the assets by that pair. After you add or rename a source, run `pnpm -C ingestion generate-sources` and commit `sources.json`.
- Read JSON inputs with `readJson` inside `extract` or `stream`, never at import time. Then a bad file fails the run with a logged reason, and provenance records a hash of each file the run read.

## Call sources

`sources/evm-address-code/src/source.ts` is the shape to copy:

- A zod `call` schema. Each run parses its waiting dead letters with it, and one that no longer parses is parked for a person.
- One id function for calls, shared by `callBatches` and `settleCalls`. A failed call's `id` must equal the `callId` of the record it would have produced: that record clears the dead letter.
- `extract(env, retry, context)` makes the retried calls next to the new ones. Set `retryMode: "paged"` only when `extract` reads `context.retryPages`, which `callBatches` does when you pass it `context`.
- A failed call doesn't fail the run. The records that arrived are written, the failed calls wait in `_dead_letters`, and a call that fails five runs in a row is parked.

## Stream sources

- End the range at `finalizedHead(portalClient(url))`, or at `END_BLOCK` when that comes first, so each run ends and no fork reaches the warehouse. Leave the cursor to Pipes.
- Declare `coverage.filters`, the `addresses.json` keys that narrow the stream. Coverage records filters only from files named `addresses.json`.
- Use one `evmEventDecoder` per filter: Pipes refuses two filters on the same event in one decoder.
- An error fails the run, and the next run resumes after the last batch that committed. A stream source has no dead letters.

## Settings and data

- Settings come from the environment first, then `chains/<chain>/.env`, that folder's `.env.example`, then the package `.env` (`lib/src/env.ts`). Dagster sets `CHAIN` from the source's entry in `sources.json`.
- Write to Postgres only through `lib/src/warehouse/`. Keep `infra/postgres/ops.sql` idempotent and additive; the PGlite tests load it.
- To reload data, never delete from the `_sync`, `_checkpoints` or `_dead_letters` tables in the raw schema. A changed filter or start block backfills a new generation by itself, and `SOURCE_BACKFILL_ID` rebuilds an unchanged one (`docs/source-provenance.md`).

## Code

- Import shared code from `@ingestion/lib`, chain code from `@ingestion/lib/evm`, `/solana` or `/bitcoin`, and a package's own files as `#src/<file>.ts`, extension included. Packages export their `.ts` files, so there is no build step. A dependency only one source uses goes in that source's `package.json`.
- `tsconfig.json` sets `verbatimModuleSyntax`, `erasableSyntaxOnly` and `noUncheckedIndexedAccess`: use `import type` for types, write no enums, namespaces or parameter properties, and expect `T | undefined` from an index.
- Log through the pino `logger` from `@ingestion/lib`, never `console`, so Dagster shows each line as a log event at its level.
- Tests use `node:test` and `node:assert/strict`, in a `*.test.ts` file next to the code. A source package runs only `src/*.test.ts`, so keep its tests at the top of `src/`. Fake every upstream: no test calls a real RPC, Portal or API. Warehouse tests use `pgliteWarehouse` from `lib/src/warehouse/pglite.fixture.ts`.

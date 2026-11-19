# Ingestion scripts

## Overview

Two scripts that sources do not import. `generate-sources-json.ts` writes `ingestion/sources.json`, the list of sources Dagster builds its assets from. `benchmark-upserts.py` measures how much write-ahead log an unchanged JSON upsert costs, the measurement behind the upsert in `../lib/src/warehouse/index.ts` (`docs/ingestion-performance.md`).

## Interface

- `generate-sources-json.ts`: run as `pnpm -C ingestion generate-sources [out]`. Writes a JSON array of `{ name, table, package, settings?, coverage? }` to `ingestion/sources.json`, or to `out` when given. `orchestration/tests/test_sources_json.py` passes `out` to compare a fresh list with the committed file.
- `benchmark-upserts.py`: `main()`. Prints a JSON list of `{ trial, variant, rows, execution_ms, wal_bytes }` for two upsert variants: `original` sets `data = excluded.data`; `reuse` keeps the stored value when it is not distinct. Run it with the orchestration Python environment, which has `psycopg2`: `uv run --project orchestration python ingestion/scripts/benchmark-upserts.py`.

## Invariants

- The generator imports each `sources/<package>/src/source.ts` and never `src/index.ts`, which runs the source. So `source.ts` must have no side effects.
- It finds a Source by shape: an export with a string `name` and `table`, whatever the export is called.
- A package without `chains/` must export exactly one Source, or the generator throws.
- A package with `chains/` must export `forChain(chain)`. The generator calls it once per chain folder, sorted, skipping hidden ones. Each call must return a Source named for its chain, and the entry gets `settings: "chains/<chain>"`. An empty `chains/` throws.
- An entry copies the source's `coverage` when it declares one.
- Entries sort by `name`, then `table`. Two packages that export the same `name.table` make it throw.
- The benchmark reads `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER` and `WAREHOUSE_PASSWORD`, never `WAREHOUSE_DB`. It needs the `CREATEDB` and `CHECKPOINT` privileges. It works in a new database named `bj_upsert_bench_<12 hex>` and drops it in `finally`. Each of 3 trials upserts the same 1,000 rows of about 16 KB.

## Side Effects

- The generator runs each source package's `src/source.ts` module, writes the output file, and prints `wrote <n> sources to <path>`.
- The benchmark connects to the server's `postgres` database, creates and drops its scratch database (`drop database ... with (force)`), runs `checkpoint` before each upsert, and prints the results.

## Verification

- Run: `pnpm -C ingestion generate-sources`
- Run: `uv run --project orchestration pytest orchestration/tests/test_sources_json.py`, which fails when `sources.json` falls behind the code. `uv run --project orchestration pytest` runs every test.

# Source configuration and historical coverage

`bj coverage` reads block intervals committed by ingestion together with their actual dataset and
address filters. Editing `START_BLOCK` or `addresses.json` cannot retroactively certify old data.
Each interval commits in the same transaction as its raw rows and Pipes cursor, including batches
that contain no matching events. A failed batch contributes no coverage.

After the first recorded configuration, changing a source's dataset URL, start block, address
filters or pool-discovery start creates an independent cursor. That generation backfills the new
configuration into the existing raw table. Upserts preserve existing record IDs and data; previous
cursors and coverage remain available. Raising `END_BLOCK` or changing a run's block cap continues
the same generation. Source names, dbt models and Dagster asset keys remain unchanged.

Uniswap's pool-discovery SQLite cache also belongs to its configuration. Changed configurations
rebuild pool history in a separate cache file, so a newly tracked token's pools created before the
swap window are discovered. The original cache is retained. Keep the cache files with the warehouse
cursors; removing a cache alone still fails safely when its cursor has already advanced.

## Existing warehouses

On upgrade, the first configuration continues the existing cursor without resetting or replaying
data. History written before provenance existed is **unverified**: a cursor alone cannot establish
which filters produced it. Ordinary stream sources can verify new blocks as they commit. A resumed
legacy Uniswap cache remains unverified until pool discovery is rebuilt under a recorded contract.
This changes the strength of coverage evidence, not whether existing ingestion jobs run.

The `covered` field is null when there is no single verified interval for the current filters.
`verified_ranges` preserves separate intervals, and `generations` shows their recorded contracts.
`bj answer` will report a coverage gap instead of certifying unverified history. API credentials
are never written to these records; the dataset URL is represented by a SHA-256 hash.

## Per-run input fingerprints

New ingestion runs record fingerprints in `RAW_SCHEMA._ingestion_inputs`, keyed by their exact
`ops.ingestion_runs.run_id` and source table. These apply to call sources as well as streams.
The evidence includes parsed non-secret settings, provider origins and URL hashes, and SHA-256
hashes plus byte lengths of JSON files actually read during extraction. Reads inside lazy
generators are captured; a later file edit does not rewrite the evidence for an earlier run.
Binance and Coinbase read their token lists through this same capture path.

Call-source evidence retains hashes rather than copies of wallet or token lists. Credential fields
are omitted, unknown text/list settings are hashed, and provider URL userinfo, paths and query
strings are never stored in plain text. At most 128 files and 16 distinct versions of each file
are recorded; exceeding either bound marks the evidence `truncated` and incomplete. Custom sources
must use `readJson` during extraction for their JSON files to participate in this capture.

Evidence commits with each raw batch and checkpoint, initially with `complete: false`. Finishing
extraction marks it complete, including successful runs that return no rows. A run interrupted
after a committed batch retains incomplete evidence. Unavailable evidence permissions or metadata
writes leave ingestion working, with a warning and absent or incomplete provenance. Missing records
from older runs remain unknown. Analysis results associate the last successful ingestion run with
only its exact matching evidence; they do not substitute a newer run's settings.

These are input fingerprints, not replayable configuration history or lineage for every row in
an accumulated raw table. `complete` means extraction finished without truncating this capture;
it does not certify historical coverage, successful individual API calls, or JSON read outside
`readJson` by a custom source.

## Nondestructive backfill

Choose a stable identifier and keep it in the root `.env` for subsequent runs:

```dotenv
SOURCE_BACKFILL_ID=verified-history-2026-11
```

Run the relevant pipeline normally, optionally capping each invocation:

```sh
MAX_BLOCKS_PER_RUN=100000 bj run transfers
bj coverage ethereum.erc20_transfers
```

Repeat the run until the required window is verified. Keep the same `SOURCE_BACKFILL_ID` so scheduled
and manual runs resume the rebuilt generation, especially for Uniswap. A new identifier deliberately
starts another backfill; removing it selects the generation without that identifier, which can resume
an older cursor or start a new backfill if that configuration was never registered. The value must
contain 1–64 letters, numbers, dots, underscores or hyphens, beginning with a letter or number.
For direct `pnpm ingest`, export the same variable in that process's environment. This procedure
does not drop raw tables, erase old cursors or delete caches. Backfills can make many provider
requests, so use the ordinary run caps and concurrency settings.

## Local proxy endpoints

An empty or absent `EVM_RPC_URL` on a known EVM chain selects
`http://localhost:<ERPC_PORT>/main/evm/<chain-id>`. An empty or absent `DSHACKLE_URL` selects
`http://localhost:<DSHACKLE_PORT>/bitcoin`. Ports come from the process environment, then the root
`.env`, then the existing defaults (4000 and 8545). Explicit source or process URLs always win,
including remote providers and existing installations' fixed localhost URLs.

Fresh local-source examples use these derived endpoints. To opt an existing installation into
port derivation, remove its fixed URL or set it empty. Sources configured with archive providers
retain their explicit URLs.

`bj` retains its existing Python-dotenv root `.env` semantics, including `${VAR}` interpolation;
resolved values enter the process environment and are inherited by Node ingestion. Explicit process
values win. Direct `pnpm ingest` retains its source-local configuration and process overrides; it
does not newly load the whole root file. The local-proxy fallback reads root port literals when no
port has been provided in the process.

Source and chain files use Node dotenv syntax: no variable interpolation, and only `\n` and `\r`
escapes inside double quotes expand. `bj coverage` uses that same source-file grammar and ECMAScript
numeric whitespace rules, after the same resolved process overrides that ingestion receives.

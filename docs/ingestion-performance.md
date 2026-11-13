# Ingestion progress and resource use

Existing source names, raw table names, record IDs, CLI commands, and observation timestamps remain unchanged. New progress tables are created automatically when a source opens its warehouse. No raw data is deleted on upgrade.

## Historical API sources

Binance, Coinbase, and Gamma save request progress in `raw._checkpoints` (or the configured `RAW_SCHEMA`). Each checkpoint commits in the same transaction as its records and failed calls. A crash resumes unfinished backfill; a request failure remains a dead letter even when the backfill advances. Checkpoints describe requests attempted, not complete data coverage. Parked dead letters still require attention.

Checkpoints are scoped to provider URL, market/protocol, interval, and configured start. Their keys are hashes, so URLs and credentials are not stored in the progress table. Adding a token backfills that token; changing an interval or start creates its own progress. Existing warehouses without checkpoints perform one initial backfill and retain all existing rows.

The optional settings apply to these three API sources:

| Setting | Default | Behavior |
|---|---:|---|
| `HISTORY_OVERLAP_DAYS` | `3` | Revisit recent history on ordinary runs, rounded down to whole request windows. Zero still revisits the current incomplete window/day. |
| `HISTORY_REFRESH_DAYS` | `7` | Start a full historical correction sweep after this many days since the previous sweep completed. An interrupted sweep resumes its cursor. |
| `HISTORY_FULL_REFRESH` | `0` | Set to `1` for one run to start from configured history again; unset afterwards. |

Gamma always walks open markets and future-dated closed markets for both protocols. A failed older future walk retains its earlier lower bound, even when it predates the normal recent overlap. Candle sources keep provider window alignment and exclude candles still open at request time.

An old provider correction outside the recent overlap appears on the next full sweep, or immediately after an explicit full refresh. This policy trades repeated historical requests for a documented correction interval. Example from the repository root:

```sh
HISTORY_FULL_REFRESH=1 bj run prices
HISTORY_FULL_REFRESH=1 bj run polymarket
```

For every-run full history, set `HISTORY_FULL_REFRESH=1` persistently. Do not delete `_checkpoints` or `_dead_letters` to refresh data.

## Bounded production and retries

EVM and Solana call sources produce at most 100 calls and retain one result batch at a time. EVM calls keep one snapshot block for a run and still start together within each batch for RPC/multicall batching. Wallet/token products are generated lazily; memory grows with configured address lists, not their Cartesian product. Transport concurrency and API weight/rate limits still apply.

The runner reads dead letters in pages of 500 with a fixed upper boundary and keyset cursor. Successful deletions and failed attempts cannot shift later pages or replay the same failure within a run. Failures created during a run wait for the next run. Schema-invalid calls are parked without hiding valid calls in later pages. `Source.extract(env, retry)` remains valid; custom sources should consume `context.retryPages` (or use `callBatches`/`retryPages`) to process more than the initial page. Sources that ignore the optional context leave additional retries queued for later runs.

Bitcoin keeps one native `scantxoutset` operation over its wallet set. Splitting that operation would repeat an entire UTXO scan and mix block heights. Its wallet set and the provider's response remain a memory floor; this change does not claim bounded memory for an arbitrarily large native UTXO response. Provider response/page sizes similarly remain outside the call producer's bound.

## Writes and telemetry

Every observation still refreshes `_loaded_at`, including identical values, preserving freshness and latest-snapshot tie semantics. When JSON is identical, the upsert retains PostgreSQL's existing JSON datum instead of re-TOASTing it. Heap updates remain necessary to preserve observation time. A synthetic PostgreSQL 16 benchmark with 1,000 unchanged 16KB JSON objects measured 0.35–0.38 MB of WAL versus 35.28–35.30 MB previously across three trials. This result applies to that fixture; small rows and real provider mixes have different costs. Reproduce against a disposable local server with `ingestion/scripts/benchmark-upserts.py`.

Structured `Batch committed` logs include committed counts, transaction/write duration, and RSS memory. Stream progress is published after rows and the block cursor commit, so a failed commit never inflates durable counts. `load_seconds` includes transaction overhead, locking, retries, and commit; call sources also report explicit `commit_seconds`. Streams expose transaction overhead separately because Pipes owns their commit; it is not mislabeled as pure commit time.

When `PUSHGATEWAY_URL` is configured, `ingestion_current_*` gauges refresh every 15 seconds while a run is active and once when it ends. They expose committed batches/records, call outcomes, retries, elapsed/load/write/commit time, memory, and the last committed stream block. They do not overwrite the previous completed run's success metric. A metrics failure only warns. After abrupt termination, use the progress timestamp to identify stale gauges.

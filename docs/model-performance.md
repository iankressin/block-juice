# Model performance and historical corrections

The models preserve live staging views and their existing public names. Selective builds retain
their existing upstream freshness behavior, including dependencies on other materialized marts.
The changes here target repeated work inside a query;
they do not introduce an event-time watermark that could omit late corrections.

## Query changes

`bridge_pairs` counts ready withdrawals in cumulative windows. The count includes withdrawals ready
at exactly the deposit timestamp and excludes withdrawals on the deposit's chain. The original
nth-withdrawal/nth-deposit pairing remains unchanged. Two sorts replace a withdrawal scan for each
paired deposit.

`polymarket_price_candles` retains a three-number tuple for each endpoint: block number, log index,
and price. The source's `block:logIndex` key makes this ordering unique for each token leg. This avoids
collecting two price arrays proportional to the number of fills in a minute. Complementary prices,
own-token volumes, and null endpoint prices retain their existing meaning. This bounds aggregate
state; it does not promise lower latency for every distribution.

`polymarket_markets` parses Gamma once in a materialized CTE shared by its naming and token-eligibility
selections. Their distinct winner rules remain separate, including Gamma rows without token IDs.
The cache lasts for one query, so old metadata corrections remain visible immediately. The existing
public intermediate views remain dependencies of the scheduled graph.

Deployment state-gas queries materialize only the trace, transaction, and state-diff columns they
actually use. Failed ancestor handling, existing-account detection, distinct new storage slots, and
the state-gas formula are unchanged. The existing nested-loop guard remains in place.

## Optional indexes for repeated state readings

For warehouses that repeatedly query many historical address-code or account-state readings, run
the corresponding operation against your configured warehouse:

```sh
dbt run-operation index_state_readings --args '{family: address_code}' \
  --project-dir transformation --profiles-dir transformation
dbt run-operation index_state_readings --args '{family: account_state}' \
  --project-dir transformation --profiles-dir transformation
```

The operation creates expression indexes matching the existing `DISTINCT ON` ordering, then runs
`ANALYZE`. It skips raw tables that have not been ingested. Builds use `CREATE INDEX CONCURRENTLY`,
which permits ingestion writes; they still consume CPU, I/O, and storage. They are explicit maintenance
operations, never automatic ingestion or model hooks. An advisory lock prevents duplicate index builds.
If another session holds that lock, the operation reports the skip; rerun after that session finishes.

If interrupted, rerun the same command. It repairs its own invalid index before retrying. Valid indexes
are retained on subsequent runs. Errors caused by malformed raw values must first be corrected in the
same way as errors in the corresponding staging model. Index names begin with `bj_state_`; inspect
`pg_indexes` before removing an index you no longer need.

## Measurements and reproduction

These are synthetic PostgreSQL 16 measurements, not production throughput promises. Each value is
the median of three `EXPLAIN (ANALYZE, BUFFERS)` executions with JIT disabled and 4 MiB `work_mem`.
The deployed model's nested-loop guard is used for deployment and Polymarket cases. A shared test host
introduces timing variation; inspect the returned plans and all timings when reproducing.

| Workload | Before | After |
| --- | ---: | ---: |
| Bridge, 1,000 withdrawals and 1,000 deposits sharing a key | 146 ms | 10 ms |
| Bridge, 5,000 withdrawals and 5,000 deposits sharing a key | 3,847 ms | 67 ms |
| Gamma, 10,000 markets | 155 ms | 115 ms |
| Deployments, 1,000 transactions with 100 traces each | 537 ms | 479 ms |
| Address code, 200,000 readings / 1,000 addresses, optional index | 456 ms | 124 ms |
| Account state, 200,000 readings, optional index | 795 ms | 427 ms |

The candle workload had similar latency at 10,000 fills and varied around 340–405 ms at 100,000
fills. Its improvement is constant-size endpoint state, not a claimed speedup. Balance and token
index candidates showed smaller or
inconsistent changes, so the operation does not install them.

From an environment with the orchestration dependencies and `WAREHOUSE_HOST`, `WAREHOUSE_PORT`,
`WAREHOUSE_USER`, `WAREHOUSE_PASSWORD`, and `WAREHOUSE_DB` set to a test PostgreSQL server:

```sh
python transformation/benchmarks/state_models.py --baseline-ref fc873ce --case all > state-models.jsonl
```

The baseline commit must exist in the local checkout. The harness creates only temporary relations
and rolls them back between cases. Its output includes timings and plans. Use `--case bridge`,
`candles`, `gamma`, `deployments`, `address_code`, or `snapshots` for a focused comparison.

## Why state models still recompute their inputs

| Family | Correction dependency and retained behavior |
| --- | --- |
| Balances and token metadata | Highest block wins, then latest observation at the same block. A correction to an old reading must be considered. Full selection remains; candidate expression indexes did not provide a consistent enough benefit to install. |
| Address code and account state | Late code/balance/nonce readings change old keys. Live views remain, with optional measured ordering indexes. |
| CoW and wallet outflows | Late call traces reveal an order UID; later trades and corrected receipts change old orders and outflow classification. Open orders can have a null UID, so a forced nonnull incremental key would break existing partial loads. |
| Transfer classification and labels | A changed exchange label or another token sent to a different recipient can reclassify historical transfers and disqualify a deposit address. Full dependency evaluation remains. |
| Polymarket ledger and participants | Metadata changes, resolutions, new price marks, redemptions, and removed/corrected events can revalue old holders without a new fill. All affected history remains in the query. |
| Bridge state | A corrected timestamp or amount can change prior pairing and candidate counts; the cumulative query recomputes the complete current input. |
| Deployments | Corrected ancestor errors, transaction status, and state diffs can change an old transaction's result; the full input remains authoritative. |

Cross-model persistent caches were evaluated but would make legacy direct mart selections read stale
data unless callers also rebuilt their upstream caches. The shared Gamma work is instead reused
inside a query. Other live projections remain live. A changed-key incremental implementation requires
a complete committed change/deletion feed and dependency invalidation; `_loaded_at` alone is not such
a feed because transaction-start timestamps can commit out of order. The regression fixtures cover
these historical corrections rather than claiming an append-only optimization is safe.

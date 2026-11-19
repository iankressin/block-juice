# evm-contract-deployments

## Overview

A stream source that reads every contract deployment on one EVM chain from Portal: each transaction with a create trace, its create traces and the frames above them, and the transaction's state diffs. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_contract_deployments`. dbt reads it through the staging models `stg_ethereum__contract_deployments`, `stg_ethereum__contract_deployments_transactions` and `stg_ethereum__contract_deployments_state_diffs` in `transformation/models/staging/ethereum/`.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<ContractDeploymentsEnv>` for one chain, with `name` the chain, `table` `contract_deployments` and `coverage` `{ filters: [], unrestricted: [] }`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:ContractDeploymentsEnv`: `PORTAL_URL` (required), `PORTAL_API_KEY` (optional), `START_BLOCK` (required) and `END_BLOCK` (optional, for a short check window).
- `src/source.ts:blockRecords(block)`: turns one Portal block into its records.
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/.env.example`: `PORTAL_URL`, `START_BLOCK` and a commented `END_BLOCK`. Only `chains/ethereum/` exists.
- `chains/<chain>/addresses.json`: `{}`. The source reads no file; it takes every create on the chain.
- `.env.example`: the warehouse settings, `PORTAL_API_KEY`, `PUSHGATEWAY_URL`, `LOG_LEVEL` and `MAX_BLOCKS_PER_RUN`.
- `package.json`: `@ingestion/lib`, `@subsquid/pipes` 1.0.0-beta.11 and `zod`.

## Invariants

- Records are keyed by their place in the chain (`src/source.ts:blockRecords`), and each id is also its `callId`:
  - a transaction, `tx:<hash>`, with `kind: "transaction"` and the selected transaction fields;
  - a trace, `<block>:<txIndex>:trace:<traceAddress joined by dots>`, with `kind: "trace"`, `trace_type`, `transaction_index`, `trace_address`, `subtraces`, `error`, `revert_reason`, `action` and `result`;
  - a state diff, `<block>:<txIndex>:diff:<address>:<key>`, with `kind: "state_diff"`, `transaction_index`, `address`, `key`, `diff_kind`, `prev` and `next`.
- Every record's `data` also holds `block_number` and `timestamp`.
- Only the transactions with at least one `create` trace load, with their traces and state diffs. The trace request asks for each create's parent frames and its transaction. A trace request cannot ask for state diffs, so Portal sends them all and `blockRecords` keeps those of the matched transactions.
- Failed creates and failed transactions load too. dbt decides which creates stood.
- Pipes 1.0.0-beta.11 does not type `prev` and `next` in a state diff's fields, so `stateDiffFields` adds them by a cast. dbt's new-slot rule needs them.
- The range runs from `START_BLOCK` to `END_BLOCK` or `finalizedHead(portal)`, whichever comes first, read when the run starts.
- A stream source has no dead letters. An error fails the run, and the next run resumes after the last batch that committed.

## Side Effects

- Streams blocks from `PORTAL_URL` through `portalClient` and `evmPortalStream`, sending `PORTAL_API_KEY` when set. Every state diff in the range comes over the wire, even those it drops.
- `runSource` writes the records to `raw.<chain>_contract_deployments`, the stream's configuration to `raw._source_configurations`, the blocks it covered to `raw._coverage`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`. Pipes keeps the cursor in `raw._sync`, as `<chain>_contract_deployments` for the first configuration. A changed start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-contract-deployments test`
- Run: `pnpm -C ingestion typecheck`

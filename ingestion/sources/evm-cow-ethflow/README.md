# evm-cow-ethflow

## Overview

A stream source that reads from Portal what the CoW Protocol ETH Flow orders of the listed wallets need on one EVM chain: each order placement, each `createOrder` call, and each ERC-20 Transfer into a wallet with the settlement's Trade logs in the same transaction. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_cow_ethflow`. dbt reads it through `transformation/models/staging/ethereum/stg_ethereum__cow_ethflow.sql` and `stg_ethereum__cow_ethflow_traces.sql`.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<CowEthFlowEnv>` for one chain, with `name` the chain, `table` `cow_ethflow` and `coverage` `{ filters: ["wallets", "ethFlow", "settlement"], unrestricted: [] }`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:CowEthFlowEnv`: `PORTAL_URL` (required), `PORTAL_API_KEY` (optional), `START_BLOCK` (required) and `END_BLOCK` (optional, for a short check window).
- `src/source.ts:TOPICS`: the `topic0` of `OrderPlacement`, `Trade` and `Transfer`.
- `src/source.ts:CREATE_ORDER`: `0x322bba21`, the selector of `CoWSwapEthFlow.createOrder`.
- `src/source.ts:Filter`: the `wallets`, `ethFlow` and `settlement` address sets.
- `src/source.ts:keptEvent(log, filter)`: which kept event a log is, or `undefined`.
- `src/source.ts:blockRecords(block, filter)`: turns one Portal block into its records.
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/addresses.json`: `wallets`, `ethFlow` (the ETH Flow contracts) and `settlement` (the GPv2Settlement contracts). Only `chains/ethereum/` exists.
- `chains/<chain>/.env.example`: `PORTAL_URL`, `START_BLOCK` and a commented `END_BLOCK`.
- `.env.example`: the warehouse settings, `PORTAL_API_KEY`, `PUSHGATEWAY_URL` and `LOG_LEVEL`.
- ABIs: `catalog/protocols/cow-protocol/abis/erc20.json`, `eth-flow.json` and `gpv2-settlement.json`.
- `package.json`: `@ingestion/lib`, `@subsquid/pipes` 1.0.0-beta.11, `viem` and `zod`.

## Invariants

- The stream asks Portal for three things: `OrderPlacement` logs from `ethFlow` with a wallet as `topic1`; Transfer logs with a wallet as `topic2`, with every log of their transactions; and `call` traces from a wallet to `ethFlow` with selector `CREATE_ORDER`, with their transactions.
- `keptEvent` keeps an `OrderPlacement` from an `ethFlow` contract whose sender is a wallet, any `Trade` from a `settlement` contract, and a three-topic Transfer into a wallet. A four-topic Transfer is ERC-721, and the source skips it.
- A `Trade` is kept only in transactions the stream matched, those with a Transfer into a wallet, so other traders' Trades load too. dbt keeps the ones it needs.
- A log record's id and `callId` are `<block>:<logIndex>`. Its `data` holds `kind: "log"`, `event`, `tx_hash`, `transaction_index`, `log_index`, `contract` and `args`, decoded with viem's `decodeEventLog` and the catalog ABI.
- A trace record's id and `callId` are `<block>:<txIndex>:trace:<traceAddress joined by dots>`. Its `data` holds `kind: "trace"`, `tx_hash`, `transaction_index`, `trace_address`, `error`, `from`, `to`, `value`, `sighash`, `input` and `output`. `output` is the order hash ETH Flow returned, so dbt can match the order without hashing.
- Every record's `data` also holds `block_number`, `block_hash` and `timestamp`.
- Each of `wallets`, `ethFlow` and `settlement` must list at least one address, or the run fails. `validateEthAddressList` rejects a bad address, and addresses are lowercased.
- The range runs from `START_BLOCK` to `END_BLOCK` or `finalizedHead(portal)`, whichever comes first, read when the run starts.
- `addresses.json` is read inside `stream` with `readJson`.
- A stream source has no dead letters. An error fails the run, and the next run resumes after the last batch that committed.

## Side Effects

- Streams blocks from `PORTAL_URL` through `portalClient` and `evmPortalStream`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.<chain>_cow_ethflow`, the stream's configuration to `raw._source_configurations`, the blocks it covered to `raw._coverage`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`. Pipes keeps the cursor in `raw._sync`, as `<chain>_cow_ethflow` for the first configuration. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-cow-ethflow test`
- Run: `pnpm -C ingestion typecheck`

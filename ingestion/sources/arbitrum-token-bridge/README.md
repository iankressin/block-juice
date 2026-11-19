# arbitrum-token-bridge

## Overview

A stream source that reads the Arbitrum token bridge's L2 gateway logs from Portal and loads them into `raw.arbitrum_token_bridge`. The bridge lives on one chain, so the package has no `chains/` folder: it reads `addresses.json` and `.env` at its root. dbt reads the table through `transformation/models/staging/arbitrum/stg_arbitrum__token_bridge.sql`.

## Interface

- `src/source.ts:source`: the `StreamSource<TokenBridgeEnv>`, with `name` `arbitrum`, `table` `token_bridge` and `coverage` `{ defaultPortalUrl, filters: ["tokens"], unrestricted: [] }`.
- `src/source.ts:TokenBridgeEnv`: `PORTAL_URL` (defaults to the Arbitrum One dataset), `PORTAL_API_KEY` (optional), `START_BLOCK` (required) and `END_BLOCK` (optional, for a short check window).
- `src/index.ts`: runs `source` through `runSource`.
- `addresses.json`: `tokens`, the Ethereum (L1) token addresses whose deposits to keep.
- `.env.example`: the warehouse settings, `PORTAL_URL`, `PORTAL_API_KEY`, `START_BLOCK`, `PUSHGATEWAY_URL`, `LOG_LEVEL` and `MAX_BLOCKS_PER_RUN`.
- ABI: `catalog/protocols/arbitrum-token-bridge/abis/l2-gateway.json`, for `DepositFinalized` and `WithdrawalInitiated`.
- `package.json`: `@ingestion/lib`, `@subsquid/pipes` 1.0.0-beta.11 and `zod`.

## Invariants

- Each record is one log. Its id and `callId` are `<block>:<logIndex>` (`src/source.ts:logRecord`), so a rerun replaces it.
- Each record's `data` holds `kind: "log"`, `event`, `block_number`, `timestamp`, `tx_hash`, `log_index`, `contract` and `args`, the ABI-decoded arguments.
- The stream names no contract, since the gateway router may give a token its own gateway. `DepositFinalized` is filtered on `l1Token` in `tokens`. `WithdrawalInitiated` is not filtered, since its token is not indexed.
- Any contract can emit these signatures, so each record keeps `contract`. dbt keeps only the gateways in `transformation/seeds/arbitrum_token_gateways.csv` and the tokens it needs.
- One `evmEventDecoder` per event, since Pipes refuses two filters on one event in one decoder.
- The range runs from `START_BLOCK` to `END_BLOCK` or `finalizedHead(portal)`, whichever comes first, read when the run starts.
- `addresses.json` is read inside `stream` with `readJson`. `validateEthAddressList` rejects a bad address, and tokens are lowercased. A file with no `tokens` key fails the run with a bare TypeError that names neither the file nor the key, and an empty `tokens` list is not checked.
- A stream source has no dead letters. An error fails the run, and the next run resumes after the last batch that committed.

## Side Effects

- Streams blocks from `PORTAL_URL` through `portalClient` and `evmPortalStream`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.arbitrum_token_bridge`, the stream's configuration to `raw._source_configurations`, the blocks it covered to `raw._coverage`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`. Pipes keeps the cursor in `raw._sync`, as `arbitrum_token_bridge` for the first configuration. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/arbitrum-token-bridge test`
- Run: `pnpm -C ingestion typecheck`

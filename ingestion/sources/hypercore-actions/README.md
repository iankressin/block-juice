# hypercore-actions

## Overview

A stream source that loads every HyperCore action the users listed in `addresses.json` sent, from Portal's `hyperliquid-replica-cmds` dataset. It loads into `raw.hypercore_actions`, which dbt reads through `transformation/models/staging/hypercore/stg_hypercore__actions.sql`. The dataset is not real-time: its finalized head trails the fills dataset by about two hours.

## Interface

- `src/source.ts:source`: the `StreamSource<HypercoreActionsEnv>` with `name` `hypercore` and `table` `actions`.
- `src/source.ts:HypercoreActionsEnv`: `PORTAL_URL` (default the `hyperliquid-replica-cmds` dataset), `PORTAL_API_KEY` (optional), `START_BLOCK`, `END_BLOCK` (optional).
- `src/index.ts`: runs `source` through `runSource`.
- `addresses.json`: `users`, a required, non-empty list of addresses.
- `.env.example` sets `PORTAL_URL`, `START_BLOCK` and an `END_BLOCK` that bounds a short check window. Remove `END_BLOCK` to follow the finalized head.
- `hyperliquidReplicaCmdsPortalStream` and `hyperliquidReplicaCmdsQuery` come from the workspace's pnpm patch to Pipes (`ingestion/pnpm-workspace.yaml`), which also lets the stream take a `PortalClient` as `portal`.

## Invariants

- `src/source.ts:users` fails the run when `users` is missing, empty, or holds a value that is not a non-empty string, since HyperCore users send about 1.2 billion actions a day. `validateEthAddressList` also fails it on a user that is not a valid EVM address. Users go out lowercased, as Portal returns `user`.
- `actionFields` asks for every action field but `signature`. It is typed over the SDK's `replicaCmdsApi.ActionFields`, so a field a Pipes upgrade adds fails the typecheck until it is listed.
- Each record is one action: id `<block>:<actionIndex>`, and `data` with `block_number`, `timestamp` and `action` as Portal sends it. `action` and `response` stay raw JSON; `response` is a plain string on some rejected actions, and `vaultAddress` is null when the user acted for itself.
- The range runs from `START_BLOCK` to `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- `coverage.filters` is `["users"]`, with nothing unrestricted, and `coverage.defaultPortalUrl` names the default dataset. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.hypercore_actions` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/hypercore-actions test`
- Run: `pnpm -C ingestion typecheck`

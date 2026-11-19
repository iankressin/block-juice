# polygon-polymarket-ctf

## Overview

A stream source that loads the position ledger of Polymarket's CTF era on Polygon, as emitted: the logs of ConditionalTokens, the NegRiskAdapter, the collateral adapters and the auto-redeemers, each decoded with its own ABI from `catalog/protocols/polymarket/abis/`. It loads into `raw.polygon_polymarket_ctf`, which dbt reads through `transformation/models/staging/polygon/stg_polygon__polymarket_ctf.sql`. Which wallet, collateral or condition matters is dbt's to work out.

## Interface

- `src/source.ts:polygonPolymarketCtf`: the `StreamSource<CtfEnv>` with `name` `polygon` and `table` `polymarket_ctf`.
- `src/source.ts:CtfEnv`: `PORTAL_URL` (default the `polygon-mainnet` dataset), `PORTAL_API_KEY` (optional), `START_BLOCK`, `END_BLOCK` (optional).
- `src/index.ts`: runs `polygonPolymarketCtf` through `runSource`.
- `addresses.json`, checked by the zod schema `addresses`: `conditional_tokens` and `neg_risk_adapter` (one address each), `collateral_adapters` and `auto_redeemers` (non-empty lists), and an optional non-empty `wallets` list.
- `.env.example` sets `PORTAL_URL` and `START_BLOCK`.

## Invariants

- The stream reads these events, and names each record's `event` `<group>.<Event>`:
  - `ctf`: `ConditionPreparation`, `ConditionResolution`, `PositionSplit`, `PositionsMerge`, `PayoutRedemption`.
  - `neg_risk`: `MarketPrepared`, `QuestionPrepared`, `OutcomeReported`, `PositionSplit`, `PositionsMerge`, `PositionsConverted`, `PayoutRedemption`.
  - `collateral_adapter`: `PositionSplit`, `PositionsMerged`, `PositionsRedeemed`, `PositionsConverted`.
  - `auto_redeemer`: `BinaryRedemption`, `NegRiskRedemption`.
- The group prefix matters: the collateral adapter's `PositionSplit` has the NegRiskAdapter's topic0, and only the emitting address tells them apart.
- With `wallets`, a split, merge, redemption or conversion loads only when its wallet argument is listed (`stakeholder`, `redeemer`, `initiator` or `from`, per `byWallet`). Conditions, resolutions and neg-risk markets always load whole.
- The ConditionalTokens transfers are not loaded: older adapters move positions without them (`catalog/protocols/polymarket/NOTES.md`, Q5).
- Each record is one log: id `<block>:<logIndex>`, and `data` with `kind: "log"`, `event`, `block_number`, `timestamp`, `tx_hash`, `log_index`, `contract` and `args`.
- The range runs from `START_BLOCK` to `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- `coverage.filters` is every key of `addresses`, with `wallets` unrestricted. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.polygon_polymarket_ctf` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/polygon-polymarket-ctf test`
- Run: `pnpm -C ingestion typecheck`

# What each layer does

The repo is ELT. Ingestion extracts data and loads it raw. dbt does every transformation. Keeping raw data raw means a wrong rule is fixed in SQL and rebuilt, without fetching anything again.

## Ingestion: extract and load

`ingestion/sources/<package>/`, in TypeScript.

- Fetch data as the chain returns it: logs with their ABI-decoded arguments, the transaction fields a log needs (such as `tx.from`), and state call results at a pinned block.
- Decide what to fetch, and only that: the block range, the contracts, the events, filters on indexed parameters, and the children a factory creates through Pipes' factory pattern.
- Key each record by its place in the chain, such as `<block>:<logIndex>`, so a rerun writes the same row.
- Read only the source's own inputs (its `.env`, its `addresses.json`) and the chain. Never read another source's raw table or a dbt model.
- Interpret nothing: no joins, no sign rules, no buy or sell, no unit conversion, no prices, no aggregation.
- Never change `ingestion/lib`, `runSource` or the Source contract to add a source. Each source checks its own inputs.

## Raw tables

`raw.<chain>_<table>` holds each record's `data` as the source wrote it. Nothing edits it after load. The dead letters, the run log and Pipes' cursor sit beside it.

## Staging

`transformation/models/staging/<source>/`, one view per raw table. Cast each field out of `data` into a typed column and lowercase addresses. No joins and no rules.

## Intermediate

`transformation/models/intermediate/<pipeline>/`. Joins and rules live here: swaps joined to their pools, sign conventions, buy or sell, token in and out, deduplication, units. Test each rule with a dbt unit test built from a real log in the protocol's catalog `NOTES.md`.

## Marts

`transformation/models/marts/<pipeline>/`. Facts that many questions reuse, such as one row per trade or per balance reading, with tests on the grain. Reconciliation tests, which compare rebuilt values with state reads, go in `transformation/tests/`.

## Analyses and answers

`transformation/analyses/<name>.sql` holds one question's filter, window and aggregation, over marts only. `answers/<slug>/` holds what `bj answer` writes and the `answer.md` you write.

## Where does it go?

| Work | Layer |
|---|---|
| Which contracts, blocks and events to fetch | ingestion |
| Decoding a log with its ABI | ingestion |
| A log's transaction sender | ingestion |
| Casting a field, lowercasing an address | staging |
| Joining swaps to pools, finding a pool's tokens | intermediate |
| Sign rules, buy or sell, token in and out | intermediate |
| Decimals, USD values | intermediate or mart |
| One question's filter, window and count | analysis |

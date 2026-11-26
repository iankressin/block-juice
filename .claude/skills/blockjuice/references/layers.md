# What each layer does

The repo is ELT. Ingestion extracts data and loads it raw. dbt does every transformation. Keeping raw data raw means a wrong rule is fixed in SQL and rebuilt, without fetching anything again.

This file says which layer each piece of work belongs in. The rules inside a layer, such as how to key a record, name a model or test a mart, are in [ingestion/CLAUDE.md](../../../../ingestion/CLAUDE.md) and [transformation/CLAUDE.md](../../../../transformation/CLAUDE.md). Read the one for the layer you change.

## Ingestion: extract and load

`ingestion/sources/<package>/`, in TypeScript.

- One source and one raw table per contract system: one version of one protocol on one chain, such as Uniswap v3 on Ethereum. Never load two versions or two protocols into one table, even when their events look alike, since each version's schema and rules change on their own. Name the package `evm-<protocol>-<version>`, such as `evm-uniswap-v3`, with one folder per chain in its `chains/`: each chain is a source of its own and loads `raw.<chain>_<protocol>_<version>`. A protocol that lives on one chain is named for that chain, such as `arbitrum-token-bridge`.
- Fetch data as the chain returns it. Each record is one item Portal or the RPC returns: a log with its ABI-decoded arguments, a transaction, a trace, or a state call's result at a pinned block. A source never combines items or interprets them; dbt does both.

## Raw tables

`raw.<chain>_<table>` holds each record's `data` as the source wrote it. Nothing edits it after load. The dead letters, the call sources' checkpoints and Pipes' cursor sit beside it, in `_dead_letters`, `_checkpoints` and `_sync`. The run log lives in the `ops` schema.

## Staging

`transformation/models/staging/<source>/`. Typed views over the raw tables, with no joins and no rules.

## Intermediate

`transformation/models/intermediate/<pipeline>/`. Joins and rules live here: swaps joined to their pools, sign conventions, buy or sell, token in and out, deduplication, units. Each protocol version gets its own model, which brings its rows into the mart's shape.

## Marts

`transformation/models/marts/<pipeline>/`. Facts that many questions reuse, such as one row per trade or per balance reading.

## Analyses and answers

`answers/<slug>/analyses/<name>.sql` holds one question's filter and aggregation, over marts only. `answers/<slug>/` also holds the `question.yaml` that names those analyses, what `bj answer` writes and the `answer.md` you write. Git tracks `question.yaml`, `analyses/` and `macros/`; commit them together.

## Where does it go?

| Work | Layer |
|---|---|
| Which contracts, blocks and events to fetch | ingestion, one source per protocol version |
| Decoding a log with its ABI | ingestion |
| Loading the transactions that logs came from | ingestion, as their own records |
| Joining a log to its transaction, such as for `tx.from` | intermediate |
| Casting a field, lowercasing an EVM address | staging |
| Joining swaps to pools, finding a pool's tokens | intermediate |
| Sign rules, buy or sell, token in and out | intermediate, one model per version |
| Putting v2, v3 and v4 trades side by side | mart, as a union of the version models |
| Decimals, USD values | intermediate or mart |
| One question's filter, window and count | analysis |

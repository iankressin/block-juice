# Transformation

This folder's contract (interface, invariants and side effects) is in [README.md](README.md), and each folder under `models/`, `macros/` and `benchmarks/` has its own.

The dbt project. Run dbt with the command in the root `CLAUDE.md`, which exports `.env` first. Raw tables live in `RAW_SCHEMA` (`raw`) and models build in `DBT_SCHEMA` (`analytics`).

CI makes an empty raw table for every source and builds every model on them, so each unit test passes and each data test's SQL runs, or the pull request fails. The reference tests stay out. To run that check yourself, point `WAREHOUSE_DB` at a new, empty database and run the two commands of the step `dbt build with unit tests on empty raw tables` in `.github/workflows/ci.yml` from `transformation/`.

## Layers

- Staging, in `models/staging/<name>/`: one view per raw table and kind of record, named `stg_<name>__<table>`, where `<name>` is the source's name (the chain for `evm-*` sources). A raw table that holds logs and transactions gets `stg_<name>__<table>` and `stg_<name>__<table>_transactions`. Cast fields out of `data` and lowercase EVM addresses. Keep Solana and Bitcoin addresses as they are, since base58 is case-sensitive. No joins and no rules.
- Intermediate, in `models/intermediate/<pipeline>/`: joins and rules, one model per protocol version, named `int_<chain>_<protocol>_<version>_<thing>`. Give each rule a dbt unit test built from a real log in the protocol's `catalog/protocols/<name>/NOTES.md`.
- Marts, in `models/marts/<pipeline>/`: facts that many questions reuse, with `unique` and `not_null` tests on the grain. A mart over several versions or chains unions their intermediate models, with a column that names each row's version or chain. Reconciliation tests that compare rebuilt values with state readings go in `tests/`.
- A test that covers every entry of a seed, such as each feed in `chainlink_feeds`, starts from the seed and left joins the loaded rows, so an entry with no rows fails instead of dropping out. It also counts rows per key, so a duplicate fails. `macros/reference_mismatches.sql` does both.
- YAML sits beside the models: `_<name>__sources.yml`, `_<name>__<table>__sources.yml` (one per table `bj new-source` adds) and `_<name>__models.yml` in staging, `_int_<pipeline>__models.yml` in intermediate (`balances/` has one per chain), `_<pipeline>__models.yml` in marts. A new seed gets its own `seeds/_<seed>__seeds.yml`; `seeds/_seeds.yml` stays as it is.

On a pull request, CI plants bugs in each model you add or change, and fails when no unit test catches them (`docs/planted-bugs.md`). So a new or changed model needs a unit test.

## Materialization

- Staging builds views and marts build tables. Intermediate models build views too, set once for the whole `intermediate` folder in `dbt_project.yml`, so each model shows as its own step in Dagster. A new intermediate folder needs no entry there.
- Keep staging and intermediate models live. Never make a model incremental with a `max(block_number)` or `max(_loaded_at)` filter: late rows and corrections would never reach the marts (`docs/fact-model-performance.md`).
- Filters and joins on jsonb staging columns get Postgres's default row estimates, and the planner picks nested loops that go quadratic on real data. The polymarket and deployments folders set `set local enable_nestloop = off` as a pre-hook in `dbt_project.yml` for this reason. When a model like that builds slowly, check its plan for nested loops first.

## Pipelines, tokens and analyses

- A new pipeline is a `models/marts/<pipeline>/` folder, and needs no edit to `orchestration/pipeline/schedules.py`: it runs at 06:00 UTC daily unless `CRON_OVERRIDES` there names it. pytest fails when an asset belongs to no scheduled pipeline.
- Join tokens on `(chain, token)`, never on `symbol`: tokens share symbols, and one token has a different address on each chain. A null `decimals` means the contract doesn't say; never assume 18.
- Each `answers/<slug>/analyses/*.sql` reads marts through `ref()`, takes its window from `in_window()` in `macros/window.sql`, and belongs to that answer's `question.yaml`. `bj answer` points dbt at one answer's folder through `BJ_ANALYSES` and `BJ_MACROS`. Outside it, an analysis compiles but fails when run, with `no window for <chain>`. To run one by hand, set `BJ_ANALYSES=../answers/<slug>/analyses` and pass `--vars '{window: {ethereum: [<first block>, <last block>]}}'`. `docs/analysis-authoring.md` covers writing one without the skill.
- `seeds/reference/` and `tests/reference/` hold the factory's reference rows and tests, tagged `reference`. Dagster and `bj answer` leave them out; run them with `dbt test --select tag:reference`.

## SQL over events

- Order events on one chain by `block_number`, then `log_index`. Never order them by timestamp, which ties every event in a block, and never break a tie by amount. `polymarket_price_candles` picks its open and close in this order.
- A running total, or a pick of the last row's total, needs an order no two rows share. Rows from one log tie, as a split's cash row and token rows do in `int_polymarket_wallet_ledger`. Give such rows a `range` frame, which gives tied rows the same total. A `rows` frame gives each one a different partial sum.
- The peak or low of a balance over a period counts the balance the period opened with, not only the balance after each of its events. A window opens with the balance at the block before it, as each interval does in `macros/erc20_balance_pairs.sql`. When the build cannot get that balance, the header comment says so.
- Check the grain after every join. A key with two rows on the joined side doubles each row it matches, so cut that side to one row per key first, as `int_polymarket_outcome_tokens` does for a condition Gamma lists in several markets. Count markets, wallets or tokens with `count(distinct ...)`, not rows.
- Take every way a quantity changes, such as splits, merges, redemptions and refunds, from the protocol's `catalog/protocols/<name>/NOTES.md`, and decide for each whether the model counts it. Name the ones it leaves out in its header comment, as `int_arbitrum_token_bridge_transfers` does for gateway refunds.

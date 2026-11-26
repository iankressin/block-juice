# Ask and answer questions

An analysis is an authored question, its definitions and input contract, and one or more SQL queries.
The command line works without Claude Code or another assistant. Start with the deterministic
[local demo](demo.md) to exercise a small dataset before loading chain history.

## Find an existing analysis

```sh
uv run --project orchestration bj questions
uv run --project orchestration bj questions tracked-wallets-eth
uv run --project orchestration bj questions --json
```

Each catalog entry names `answers/<slug>/question.yaml`, the marts it reads, and its SQL files.
The manifest is the bundle's identity and owns its ordered analyses: the first query supplies the
headline when it returns one row and one column. SQL lives under `answers/<slug>/analyses/`,
with existing filenames and dbt selectors preserved. Reusable data transformations belong in
`transformation/models/`, not in an answer directory. Runtime output belongs beside the question
and stays out of Git; ingestion and model run logs belong in `ops.*` in the warehouse.

The shipped bundles cover balances, token transfer graphs and accumulators, classified token flows,
Polymarket markets and wallet fills, UNI swaps, contract deployments, and attributed ETH flows.
`bj questions --check` checks that every SQL analysis has exactly one supported bundle and
validates each declared evaluation window with its evaluation parameters.

## Run and explain a question

1. Read the question's definitions, `window`, `inputs` and `marts`. They define the actual claim.
2. Configure the matching source filters and history, then run the required pipelines with
   `bj run <pipeline>` or Dagster. `bj answer` reads built tables; it does not ingest or build them.
   When scheduling pipelines, account for [sources shared by multiple jobs](architecture.md#add-a-pipeline).
3. Run `bj answer <slug>`. Inspect `answer.json`, its checks, and every CSV in `results/`.
   Exit 1 means a check failed. Do not treat an empty result as evidence that nothing happened
   until coverage, freshness and source failures are understood.
4. Write `answers/<slug>/answer.md` with the result, units, scope, method and limitations. Reference
   the saved CSVs. If you verify against an independent source, record what was compared with
   `bj check <slug> cross_check passed "<comparison and result>"` (or `failed`).
5. Export the saved answer with `bj report <slug> --format xlsx,pdf,docx`.

Prefix these commands with `uv run --project orchestration` when `bj` is not on your PATH.
Rerunning the question invalidates the prior narrative and manual checks; write a new narrative
for the new results. `bj answer <slug> --eval` uses a declared `eval_window` and keeps its output
separate; use `bj check <slug> --eval ...` for checks of that evaluation.

## Author a bundle

Create `answers/my-question/question.yaml` and one or more uniquely named dbt analyses. For example:

```yaml
question: How much ETH do the tracked wallets hold?
definitions:
  held: Each wallet's latest balance reading, in ETH rather than wei.
window: {chain: ethereum, at: latest}
inputs:
  - {name: eth_balances, strategy: state, mart: latest_balances}
marts: [latest_balances]
analyses: [my_question]
expected_columns: {my_question: [eth]}
```

```sql
-- answers/my-question/analyses/my_question.sql
select round(sum(balance) / 1e18, 6) as eth
from {{ ref('latest_balances') }}
where chain = 'ethereum' and asset_type = 'native'
```

Use `ref()` and `source()` so dbt can track lineage. A physical table name in SQL bypasses that
lineage and needs an explicit dependency contract. Write deterministic ordering for detail rows,
declare units and grain, and put reusable joins or event decoding in models. Never multiply raw
amounts by a guessed decimals value or infer completeness from a query returning rows.

History questions declare inclusive block ranges by chain and the source filters they need:

```yaml
window:
  blocks: {ethereum: [26194189, 26201364]}
inputs:
  - source: ethereum.uniswap_v3
    strategy: history
    filter: {tokens: ["0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"]}
```

Quote addresses in YAML. Apply the same window in SQL with `in_window('block_number', 'ethereum')`.
`bj coverage` reads the current `START_BLOCK` and address filter, and the blocks each generation
has verified under them. To cover an earlier start or new addresses, change `START_BLOCK` or
`addresses.json`: the next run backfills a new generation into the same raw table and keeps the
rows already loaded. When the settings used for earlier blocks are unknown, set a
`SOURCE_BACKFILL_ID` and follow the [nondestructive backfill](source-provenance.md#nondestructive-backfill).
Rerun the pipeline until `bj coverage` shows the window verified, as
[reuse before you build](../.claude/skills/blockjuice/workflows/history-source.md#reuse-before-you-build) says.

For a transfer analysis covering every wallet, set `all_wallets: true` on the source input.
Coverage then requires the source's `addresses.json` to omit `wallets`. For a specific wallet
or group, list the addresses under `filter.wallets`.

For summaries of whatever is loaded, declare `window: {scope: loaded}` explicitly. That records
the source inventory without asserting complete historical coverage. The Polymarket overview
uses this mode because its current-position metrics cannot be restricted by a trade-date filter.

Each `token-*` bundle now owns a typed `parameters.token` default for the Ethereum token, decimals
and chain-specific token addresses and windows. The default is UNI on Arbitrum and Base. Put an
override in the question's `values.token` map; the runner validates it and supplies it as a dbt
variable. The old `vars.token` project default remains for direct dbt users, who can override it
with `--vars '{token: {...}}'`. The shipped bundles declare `parameter_scope: token_windows`:
the runner rejects token windows or transfer/bridge filters that disagree with the resolved token
parameters before compiling or running SQL. Update the block windows and source filters together
with a changed token mapping. Changing only a label does not change the SQL. Graph and
accumulator detail queries produce chain-specific columns, so a changed chain set needs a changed
column contract too.

For a token question's smaller `eval_window`, declare a complete typed `eval_values.token` override
whose chain ranges match that evaluation window. `values.token` and the defaults remain the full
answer's parameters. An evaluation that still supplies full-window parameters is rejected; it
cannot certify a smaller slice while querying the full history. Arbitrum bridge filters identify
the Ethereum token, while Base OP bridge filters identify its Base token address.

Every query in a checked-in bundle must declare its ordered `expected_columns`. Detail queries
with a stable unique key also declare `grain`. New questions can add typed parameters and a
freshness policy:

```yaml
parameters:
  threshold: {type: integer, default: 100}
values: {threshold: 200}
expected_columns:
  my_question: [{name: eth, type: numeric}]
execution: {statement_timeout_ms: 900000, lock_timeout_ms: 10000, fetch_size: 1000}
freshness: {max_age_hours: 24, require_model_build: true}
```

Use only parameters your SQL actually reads. Choose freshness and row limits for the question's
purpose; a historical snapshot need not satisfy a live dashboard's age policy. The
[analysis runtime contract](analysis-runtime.md) describes immutable runs, streaming results,
snapshot consistency, parameter schemas and the precise checks. To track ingestion progress,
see [monitoring](architecture.md#monitoring).

The shipped `tracked-wallets-eth` and `tracked-wallets-sol` questions require source observations
from the last 48 hours and a recorded model build after those inputs were loaded. Run `bj run
balances` to ingest, build and record that evidence. A direct unlogged `dbt build` cannot prove
when the saved balances were built. Fixed-window historical questions do not impose this age
policy.

Validate with `bj questions --check` and the relevant model tests. To compile an analysis from the
repository root, export the warehouse settings from `.env` first (see
[local setup](architecture.md#local-setup-detail)), then run:

```sh
uv run --project orchestration dbt compile --project-dir transformation \
  --profiles-dir transformation --select <analysis-name>
```

Compare results against a small independent fixture, including empty input and late data.
The [factory reference contract](../transformation/seeds/reference/README.md) is also usable by hand;
its reference tests are opt-in and do not run as ordinary pipeline checks.

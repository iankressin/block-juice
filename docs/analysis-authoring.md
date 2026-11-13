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
headline when it returns one row and one column. SQL remains under `transformation/analyses/`,
with existing filenames and dbt selectors preserved. Reusable data transformations belong in
`transformation/models/`, not in an answer directory. Runtime output belongs beside the question
and stays out of Git; ingestion and model run logs belong in `ops.*` in the warehouse.

The shipped bundles cover balances, token transfer graphs and accumulators, classified token flows,
Polymarket markets and wallet fills, UNI swaps, contract deployments, and attributed ETH flows.
`bj questions --check` checks that every SQL analysis has exactly one supported bundle; CI runs
the same catalog contract. A successful catalog check validates authorship, not data availability.

## Run and explain a question

1. Read the question's definitions, `window`, `inputs` and `marts`. They define the actual claim.
2. Configure the matching source filters and history, then run the required pipelines with
   `bj run <pipeline>` or Dagster. `bj answer` reads built tables; it does not ingest or build them.
   See [scheduling](scheduling.md) to avoid duplicate upstream work in recurring runs.
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
```

```sql
-- transformation/analyses/my_question.sql
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
Changing a source filter does not backfill its prior cursor automatically. Follow the coverage
workflow in [source provenance](source-provenance.md) before claiming the changed dataset is complete.
For summaries of whatever is loaded, declare `window: {scope: loaded}` explicitly. That records
the source inventory without asserting complete historical coverage. The Polymarket overview
uses this mode because its current-position metrics cannot be restricted by a trade-date filter.

Each `token-*` bundle now owns a typed `parameters.token` default for the Ethereum token, decimals
and chain-specific token addresses and windows. The default is UNI on Arbitrum and Base. Put an
override in the question's `values.token` map; the runner validates it and supplies it as a dbt
variable. The old `vars.token` project default remains for direct dbt users, who can override it
with `--vars '{token: {...}}'`. Keep the question's block windows, source filters and expected output
columns aligned with the token mapping; changing only a label does not change the SQL. Graph and
accumulator detail queries produce chain-specific columns, so a changed chain set needs a changed
column contract too.

All shipped queries declare their ordered `expected_columns`, and detail queries with a stable
unique key also declare `grain`. New questions can add typed parameters, result contracts and a
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
snapshot consistency, parameter schemas and the precise checks. For ingestion/backfill policy
and live progress, see [ingestion performance](ingestion-performance.md).

The shipped `tracked-wallets-eth` and `tracked-wallets-sol` questions require source observations
from the last 48 hours and a recorded model build after those inputs were loaded. Run `bj run
balances` to ingest, build and record that evidence. A direct unlogged `dbt build` cannot prove
when the saved balances were built. Fixed-window historical questions do not impose this age
policy. For model refresh choices and reproducible benchmarks, see
[fact model performance](fact-model-performance.md).

Validate with `bj questions --check`, `dbt compile --select <analysis-name>` and the relevant model
tests. Compare results against a small independent fixture, including empty input and late data.
The [factory reference contract](../transformation/seeds/reference/README.md) is also usable by hand;
its reference tests are opt-in and do not run as ordinary pipeline checks.

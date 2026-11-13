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
workflow before claiming the changed dataset is complete.

The existing `token-*` bundles share `vars.token` for the Ethereum token, decimals and chain-specific
token addresses and windows. The default is UNI on Arbitrum and Base. When using direct dbt commands,
override the complete mapping with `--vars '{token: {...}}'`. Keep the question's block windows and
source filters aligned with the token mapping; changing only the label does not change the SQL.

Validate with `bj questions --check`, `dbt compile --select <analysis-name>` and the relevant model
tests. Compare results against a small independent fixture, including empty input and late data.
The [factory reference contract](../transformation/seeds/reference/README.md) is also usable by hand;
its reference tests are opt-in and do not run as ordinary pipeline checks.

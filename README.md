# ELT pipeline

| Stage     | Tool       | Folder            |
|-----------|------------|-------------------|
| Extract + load | TypeScript | `ingestion/`      |
| Transform | dbt        | `transformation/` |
| Orchestrate | Dagster  | `orchestration/`  |

Data flow: a TypeScript source writes raw JSON rows into `raw.<source>_<table>`. dbt reads them through `source()`, then builds staging views and mart tables in the `analytics` schema. Dagster runs both as one asset graph.

Five sources read wallet balances: ETH, ERC-20 tokens, SOL, SPL tokens and BTC. The Ethereum sources read at `BLOCK_NUMBER`: a block number, or `latest`, `safe` or `finalized`, which each run turns into a number once at the start. A Solana RPC serves only current state, so the Solana sources read at the latest finalized slot, and each run adds a new reading, keyed by the slot it read. The Bitcoin source reads every wallet with one `scantxoutset` call through Dshackle, which scans the UTXO set at the chain tip in about a minute. Only the OnFinality upstream serves that call. Each run adds a new reading, keyed by the height it read. `analytics.latest_balances` holds each wallet's latest balance of each asset on all three chains, in the asset's base units (satoshis for BTC). On Solana its `block_number` is the slot.

Each chain reaches `latest_balances` through one model in `transformation/models/intermediate/balances/`, `int_<chain>_balances`, which puts the chain's rows in the shape the mart reads: `chain`, `wallet`, `asset_type`, `asset`, `block_number` and `balance`, with no null balance. The mart only stacks these models and keeps each wallet's latest reading of each asset. To add a chain, add its model, one `union all` branch in `latest_balances.sql`, and the chain to the mart's `accepted_values`.

A sixth source, `ethereum-erc20-transfers`, is a stream source. Through Pipes it reads every Transfer of the tokens in its `addresses.json` into or out of its wallets, from `START_BLOCK` to Portal's finalized head, and each run resumes where the last one stopped. The `transfers` pipeline builds `analytics.erc20_transfers` from it, one row per transfer, in the token's base units. Three more stream sources, `ethereum-uniswap-v2`, `-v3` and `-v4`, load the pool creations and Swaps of Uniswap pools that trade the tokens in their `addresses.json`, each version in its own raw table, with the transactions they came from as records of their own. v2 and v3 follow their factory's pools with Pipes' factory pattern, which keeps the pools it found in `factory.sqlite` in each package. The `dex` pipeline builds `analytics.dex_trades` from them, one row per trade, with each version's sign rule applied in its own intermediate model.

```
.
├── .claude/skills/blockjuice/  # the skill: SKILL.md routes to workflows/ and references/
├── answers/<slug>/             # one answer per question: question.yaml, answer.json, answer.md, results/
├── catalog/protocols/<name>/   # contracts, events and ABIs of a protocol, proven on real logs
├── docker-compose.yml          # includes infra/docker-compose.yml; run docker compose here
├── .env.example                # settings shared by all three tools
├── ingestion/                  # pnpm workspace
│   ├── pnpm-workspace.yaml
│   ├── tsconfig.json           # one typecheck for every package
│   ├── sources.json            # every source's exported name and table; `pnpm generate-sources` writes it
│   ├── lib/                    # @ingestion/lib: shared by all sources
│   │   └── src/
│   │       ├── index.ts        # public API for any chain
│   │       ├── source.ts       # Source and StreamSource interfaces
│   │       ├── portal.ts       # Portal client and finalized head, for stream sources
│   │       ├── warehouse/      # every Postgres write: raw tables, dead letters, cursors, the run log
│   │       ├── evm/            # @ingestion/lib/evm: env, addresses, client, connect()
│   │       ├── solana/         # @ingestion/lib/solana: env, addresses, client
│   │       ├── bitcoin/        # @ingestion/lib/bitcoin: env, addresses, client
│   │       ├── logger.ts       # the pino logger
│   │       └── run/            # runSource(): extract + load, logs, the run report and its metrics
│   └── sources/
│       └── <source>/           # @ingestion/<source>: one package per source
│           ├── package.json    # `ingest` script, depends on @ingestion/lib
│           └── src/
│               ├── source.ts   # the Source definition
│               └── index.ts    # entry point: runSource(source)
├── transformation/             # dbt project (profiles.yml lives here)
│   ├── analyses/               # one or more dbt analyses per answer
│   └── models/
│       ├── staging/<source>/   # sources yml + stg_ models, one folder per source
│       ├── intermediate/<pipeline>/
│       └── marts/<pipeline>/   # a pipeline's output tables, one folder per pipeline
├── infra/                      # the Postgres warehouse, eRPC, Dshackle and monitoring
│   ├── postgres/init.sql       # eRPC database and monitor role, then runs ops.sql
│   ├── postgres/ops.sql        # the ops run log, plain SQL so tests can load it
│   ├── prometheus/
│   └── grafana/
│       ├── build_dashboards.py # writes dashboards/ingestion.json and pipeline.json
│       └── check_dashboards.py # runs every dashboard query through Grafana
└── orchestration/
    ├── pipeline/
    │   ├── definitions.py      # Dagster entry point
    │   ├── project.py          # paths + DbtProject
    │   ├── run_log.py          # adds each dbt build to ops.dbt_invocations and ops.dbt_node_runs
    │   ├── cli/                # the bj CLI
    │   ├── assets/ingestion.py # one asset per TypeScript source
    │   ├── assets/dbt.py       # every dbt model as an asset
    │   └── schedules.py        # one job and schedule per pipeline
    └── tests/
```

## Run it locally

Needs Node 24 and [pnpm](https://pnpm.io), which `mise.toml` pins (`mise install` sets up both), [uv](https://docs.astral.sh/uv/) and Docker.

```sh
cp .env.example .env
docker compose up -d
(cd ingestion && pnpm install)
(cd orchestration && uv sync)

set -a && source .env && set +a
cd orchestration && uv run dagster dev
```

Open http://localhost:3000 and materialize all assets.

In `ingestion/`, a package imports another by name (`import { runSource } from "@ingestion/lib"`). Code for one chain comes from that chain's subpath: `import { connect } from "@ingestion/lib/evm"`. Inside a package, import its own files by their path from its `src`, with the `.ts` extension: `import { fetchBalances } from "#src/balances.ts"`. Each package defines `#src/` in the `imports` field of its `package.json`. Packages export their `.ts` source directly, so there is no build step; `pnpm typecheck` at `ingestion/` checks every package.

Each layer also runs alone, with the env vars loaded:

```sh
(cd ingestion/sources/ethereum-eth-balances && pnpm ingest)
(cd ingestion/sources/ethereum-erc20-balances && pnpm ingest)
(cd ingestion/sources/ethereum-erc20-transfers && pnpm ingest)
(cd ingestion/sources/solana-sol-balances && pnpm ingest)
(cd ingestion/sources/solana-spl-balances && pnpm ingest)
(cd ingestion/sources/bitcoin-btc-balances && pnpm ingest)
(cd transformation && ../orchestration/.venv/bin/dbt build)
(cd orchestration && uv run pytest)
```

## Ask a question

Open the repo in Claude Code and ask a question about chain data, or type `/bj <question>` (`/blockjuice` also works). The blockjuice skill in `.claude/skills/blockjuice/` scopes the question, finds the marts that hold the data or builds them, writes a dbt analysis, checks the result and writes the answer to `answers/<slug>/`:

- `question.yaml` says what the answer counts and over which data.
- `answer.json` holds the value, the checks and where the data came from. `bj answer` writes it.
- `answer.md` is the answer in words.
- `results/` holds one CSV per analysis.
- `reports/` holds what `bj report` builds: XLSX, PDF and Word files, and the id of the answer's Google Doc. Git ignores it.

`answers/tracked-wallets-eth/` is an example. The skill reads state through the balance sources and history through stream sources, which load events over a range of blocks. When a question involves a protocol it doesn't know, it first writes the protocol's contracts, events and their meaning to `catalog/protocols/<name>/`, each proven on a real transaction. `catalog/protocols/uniswap/` is the first entry. `.mcp.json` registers the SQD Portal MCP, which the skill uses to estimate a load and to cross-check a history answer.

The skill runs every mechanical step through the `bj` CLI, whose long name is `blockjuice`. It lives in `orchestration/pipeline/cli/` and reads `.env` itself. Run it from the repo root:

```sh
uv run --project orchestration bj --help
```

| Command | What it does |
|---|---|
| `bj answer <slug>` | Runs the answer's analyses, writes `results/` and `answer.json`, and checks the inputs: dbt tests, dead letters, the last successful run and, for history sources, coverage of the window. Exits 1 when a check fails. |
| `bj run <pipeline>` | Runs one pipeline's Dagster job in-process, after `dbt parse`. |
| `bj coverage [<source>.<table>]` | Prints the blocks each history source has loaded: `START_BLOCK` to the cursor Pipes keeps in `raw._sync`, and the addresses it read. |
| `bj check <slug> <name> <passed\|failed> <detail>` | Records a check the agent ran itself, such as a cross-check against Portal, in `answer.json`. Exits 1 when it failed. |
| `bj blocks <chain> <from> [<to>]` | Turns UTC times into the first and last block of the window, read from SQD Portal for eleven EVM chains, including Ethereum, Arbitrum and Base. An unknown chain name prints the list. |
| `bj new-source <source> <table> --like <package>` | Does the three steps of Add a source, starting from a copy of an existing source. |
| `bj report <slug> [--format xlsx,pdf,docx,gdoc]` | Builds the answer's reports from `answer.json`, `answer.md` and `results/`. `gdoc` uploads a Google Doc and needs the Google settings in `.env.example`. |

## Monitoring

`docker compose up -d` also starts Prometheus, a Pushgateway, postgres-exporter and Grafana. You can view Grafana without logging in. Sign in as `admin`/`admin` to edit or use Explore.

- Pipeline: http://localhost:3001/d/pipeline, the report of every run. Click a run in Every run to see its steps, and to zoom the warehouse and eRPC panels to the time it ran.
- Ingestion: http://localhost:3001/d/ingestion
- eRPC: http://localhost:3001/d/erpc_metrics, the dashboard that ships with the eRPC release pinned in `infra/docker-compose.yml`. Many of its panels stay empty until eRPC sees what they track, such as errors, rate limits or lagging upstreams.
- Dshackle: http://localhost:3001/d/qkG2pqWnp, the dashboard from the Dshackle release pinned in `infra/docker-compose.yml`, edited to work here. Dshackle is the Bitcoin RPC proxy at http://localhost:8545/bitcoin, and http://localhost:8082/health?detailed shows the state of each upstream.
- Prometheus: http://localhost:9090

A source run ends before Prometheus could scrape it, so each run pushes its result to the Pushgateway at `PUSHGATEWAY_URL`, and Prometheus scrapes that. The result covers whether the run succeeded, when it finished, how long it took, the records it wrote, its failed calls and the dead letters it retried, labelled by source and table. It also counts the dead letters left waiting, as `ingestion_dead_letters` with `state` set to `pending` (retried next run) or `parked` (failed too often or no longer matches the source's call schema, waits for a person). With `PUSHGATEWAY_URL` unset, a run pushes nothing.

Prometheus keeps only each source's latest result, so the history of every run lives in the warehouse, in the `ops` schema that `infra/postgres/ops.sql` creates:

- `ops.ingestion_runs` holds one row per source run. `runSource` writes it, with the error when the run failed and the time spent writing to the warehouse.
- `ops.dbt_invocations` and `ops.dbt_node_runs` hold each dbt build and each model and test in it. The Dagster dbt asset writes them from `run_results.json`, so a `dbt build` run by hand is not recorded.
- `ops.pipeline_runs` is a view with one row per Dagster run. Dagster passes its run id to each source as `DAGSTER_RUN_ID`, which ties the ingestion rows to the dbt rows of the same run.

Grafana reads the warehouse as `monitor`, a role that can read everything and change nothing. The warehouse loads `pg_stat_statements` for the query panels. The eRPC panels count only sources whose `ERPC_URL` points at eRPC.

To change a dashboard, edit `infra/grafana/build_dashboards.py`, run it, then check every query with `python3 infra/grafana/check_dashboards.py`.

## Logging

Ingestion code logs through the pino `logger` from `@ingestion/lib`, never `console`. It writes JSON lines, and Dagster shows each line as a log event at its own level. In a terminal the lines are pretty-printed. `LOG_LEVEL` sets the level, `info` by default. An unknown level logs a warning and falls back to `info`. `runSource` logs any error as fatal and sets the exit code, so a failed run leaves one log line with the stack, not Node's crash output.

## Add a source

`uv run --project orchestration bj new-source <source> <table> --like <package>` does steps 1 to 3 from a copy of `ingestion/sources/<package>/`. Then edit the copied `src/`, `addresses.json` and the staging stub. Reading the source from a mart, and scheduling that mart in `PIPELINES`, stay hand steps: see Add a pipeline, and `## Adding a chain` in `transformation/README.md`. By hand:

1. Copy `ingestion/sources/ethereum-eth-balances/` to `ingestion/sources/<source>-<table>/` (underscores in the table name become hyphens), rename the package to `@ingestion/<source>-<table>`, edit `src/source.ts`, and run `pnpm install` in `ingestion/`. The source adds its own dependencies (API client, schemas) to its own `package.json`; code that several sources share goes in `lib/`. A chain's env, addresses and client go in `lib/src/<chain>/`. Its `index.ts` lists what sources may use, and `lib/package.json` exports that file as `@ingestion/lib/<chain>`.
2. Add `transformation/models/staging/<source>/` with a sources yml and the `stg_` models.
3. Run `pnpm generate-sources` in `ingestion/`. It rewrites `ingestion/sources.json`, the list of the `name` and `table` every package exports from `src/source.ts`, with the package's folder. Dagster builds its `SOURCES` from that file, so nothing lists the sources by hand, and the orchestration tests fail while the file is stale.

The dbt source name and table name must match the `name` and `table` the source exports. Dagster keys each dbt source as `[source, table]`, and the ingestion asset uses the same key, so Dagster links them. A test names any pair that drifts.

A stream source reads blocks through a [Pipes](https://docs.sqd.dev/en/sdk/pipes-sdk) stream instead of making calls. Its `src/source.ts` exports a `StreamSource`, whose `stream(env)` returns the stream. Map the stream's outputs to records with `.pipe()`, and end its range at `finalizedHead(portalClient(url))` so each run ends. `runSource` pipes the stream into the warehouse, where Pipes keeps the source's cursor in `raw._sync` and saves it in the same transaction as the batch's records. Each run resumes after the cursor and reads at most `maxBlocksPerRun` blocks, plus the rest of the batch that passes it. To read a stream source again from its start, delete its rows from `raw._sync`, whose `id` is `<source>_<table>`.

## Add a pipeline

A pipeline is the models in `transformation/models/marts/<pipeline>/` and every asset they read from, ingestion included. Each pipeline runs as its own Dagster job, on its own schedule.

1. Add the pipeline's output models to `transformation/models/marts/<pipeline>/`, and any models that only it reads to `transformation/models/intermediate/<pipeline>/`. Staging models stay in `staging/<source>/`, because any pipeline can read them.
2. Add the pipeline's name and cron schedule to `PIPELINES` in `orchestration/pipeline/schedules.py`.

If the pipeline reads a new source, also follow Add a source. Two pipelines that read the same source each run it. The orchestration tests fail when an asset belongs to no scheduled pipeline.

## Use another warehouse

Change `ingestion/lib/src/warehouse/`, the adapter in `transformation/profiles.yml`, and `dbt-postgres` in `orchestration/pyproject.toml`.

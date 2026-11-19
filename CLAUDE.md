# BlockJuice

A self-hosted ELT framework for chain data. TypeScript sources in `ingestion/` load raw rows into Postgres, dbt in `transformation/` builds the models, Dagster in `orchestration/` runs both, and the `bj` CLI writes answers to `answers/<slug>/`. Use the terms in `GLOSSARY.md`, never the words it lists under _Avoid_.

`ingestion/`, `transformation/` and `orchestration/` each have a CLAUDE.md with that layer's rules, and `.github/` has one for the factory workflows.

Each folder with code has a README.md with its contract (interface, invariants and side effects) and a CLAUDE.md that imports it. The root README's "Code map" section links the four layers, and each layer's README links the folders under it.

## Commands

Run these from the repo root. None needs a `cd`.

- Set up a fresh checkout or worktree: `uv run --project orchestration bj install`. It copies each missing `.env` from its example, installs the pnpm packages and writes the dbt manifest. It starts nothing.
- Node 24, pinned in `mise.toml`. If `node --version` shows another major, prefix Node commands with `mise exec --`: under Node 23, tests that load PGlite can hang at exit.
- Typecheck every TS package: `pnpm -C ingestion typecheck`
- Test one package: `pnpm -C ingestion --filter @ingestion/<package> test`. One file: `pnpm -C ingestion/lib exec tsx --test src/<file>.test.ts`, or `ingestion/sources/<package>` in place of `ingestion/lib`.
- All TS tests, which take minutes: `pnpm -C ingestion -r --workspace-concurrency=1 test`. A bare `pnpm test` in `ingestion/` runs nothing and exits 1.
- dbt reads the warehouse settings from the environment and has no defaults, so export `.env` first: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- pytest: `uv run --project orchestration pytest orchestration/tests/<file>.py`, or leave out the path to run all. It needs `transformation/target/manifest.json`, which `bj install` or `dbt parse` writes, and the pnpm packages, since one test runs `generate-sources`. Run it without `.env` exported unless you want the Postgres tests to use that server (`orchestration/CLAUDE.md`).
- `uv run --project orchestration bj questions --check` checks that each analysis belongs to exactly one question. It needs no warehouse.
- `uv run --project orchestration bj --help` lists the CLI. `bj` loads `.env` itself.
- `uv run --project orchestration bj demo` runs synthetic raw rows from `examples/balances/` through the balance models to a checked answer and a report. It needs Docker, starts its own throwaway Postgres and leaves your warehouse alone.
- Leave `bj dev` to the user: it runs Dagster in the foreground.

A change is done when the checks for each layer it touches pass:

- `ingestion/`: the typecheck and the tests of each package you changed.
- `transformation/`: `dbt parse`, plus `bj questions --check` when you touch an analysis or a `question.yaml`. With a warehouse up, build what you changed with `bj run <pipeline> --select <model>`, which also runs its tests.
- `orchestration/`, or a new or renamed source, pipeline or analysis: pytest. The tests that tie the layers together live there.

CI (`.github/workflows/ci.yml`) runs the same checks on every pull request.

## How the parts connect

- **Source to raw table.** Each package in `ingestion/sources/<package>/` exports a `Source` (makes calls) or a `StreamSource` (reads blocks through Pipes); both are defined in `ingestion/lib/src/source.ts`. `runSource` (`lib/src/run/`) runs it and writes through `lib/src/warehouse/` to `raw.<name>_<table>`: `id` (primary key), `data` (jsonb) and `_loaded_at`. An `evm-*` package has one folder per chain in `chains/<chain>/`, and each folder is a source named for its chain, so `evm-erc20-transfers` loads `raw.ethereum_erc20_transfers`, `raw.base_erc20_transfers` and so on.
- **Beside the raw tables** sit `_dead_letters` (failed calls waiting for a retry), `_checkpoints` (call-source progress) and Pipes' cursor table `_sync`.
- **Models.** `transformation/models/staging/<name>/` reads each raw table through `source('<name>', '<table>')` into the view `stg_<name>__<table>`. `intermediate/<pipeline>/` holds joins and rules, and `marts/<pipeline>/` holds the tables that questions read. All of them build in the `analytics` schema (`DBT_SCHEMA`).
- **Dagster.** `orchestration/pipeline/definitions.py` makes one asset per entry in `ingestion/sources.json`, keyed `[<name>, <table>]`, the key dbt gives the matching source, which is how Dagster links the two. Every dbt model is an asset keyed by its name (`pipeline/assets/`). Each ingestion asset has a `no_dead_letters` check.
- **Pipelines.** A pipeline is a `marts/<pipeline>/` folder plus its entry in `PIPELINES` in `orchestration/pipeline/schedules.py`. Its job builds those marts and everything upstream of them, ingestion included.
- **Run log.** `infra/postgres/ops.sql` creates the `ops` schema. `runSource` writes one row per source run to `ops.ingestion_runs`; after each Dagster dbt build, `pipeline/run_log.py` writes `ops.dbt_invocations` and `ops.dbt_node_runs`. The view `ops.pipeline_runs` ties them together by Dagster run.
- **Questions.** `answers/<slug>/question.yaml` names the analyses (`transformation/analyses/<name>.sql`), the window and the inputs; `.claude/skills/blockjuice/references/question-spec.md` lists its keys. `bj answer <slug>` (`pipeline/cli/answer.py` and `pipeline/analysis/`) compiles the analyses with the window, checks the inputs (mart tests, coverage, dead letters, freshness) and writes `answer.json` and `results/`. The author writes `answer.md`, and `bj report` builds `reports/`. With `--eval`, `bj answer` writes to `eval/` instead.
- **Catalog.** `catalog/protocols/<name>/` holds a protocol's contracts, events and ABIs (`protocol.yaml`, `NOTES.md`, `abis/`), each proven on a real transaction. `catalog/vendors/<name>/` does the same for an off-chain API. Sources and dbt unit tests take their facts from here.
- **CLI.** One module per command in `orchestration/pipeline/cli/`.

## Where work goes

`.claude/skills/blockjuice/references/layers.md` says which layer does what. Read it before you add or change a source, a model or an analysis. In short:

- Sources extract and load only. Joins, sign rules, buy or sell, units, prices and aggregation all belong in dbt, so a wrong rule is fixed in SQL and rebuilt without fetching anything again.
- Each protocol version on each chain gets its own source and raw table. Marts union the per-version models.
- Keep pipelines token-agnostic. The token a question is about lives in configuration: a source's `addresses.json`, the dbt `token` var, or a question's `parameters.token`. It never appears in code, model names or catalog prose.
- Questions about chain data go through the `/bj` skill (`.claude/skills/blockjuice/`). Every answer comes from the warehouse through files in this repo, never from memory or an MCP tool alone.

## Writing code

- Change what the task needs. Don't refactor nearby code, rename things or add options nobody asked for.
- Reuse before you add. Use what a library already does (Pipes keeps the stream cursor), and grow the types `ingestion/lib` already owns (a field, a `.extend()`, a default parameter) before you add a helper layer or a base class.
- Put a limit on all work: batches, retries, pages, scans and timeouts. Name each limit as a constant, with its unit in the name when it has one: `CALL_BATCH_SIZE`, `SCAN_TIMEOUT_MS`.
- Check input where it enters (env, files, API replies, CLI arguments) and fail with a message that names the file, key or value. Past that point, trust the types.
- When a library default matters, such as a timeout or a retry count, pass it at the call site, so a new library version can't change it.
- Watch each new test or check fail once before you trust it. Plant the defect it guards against, such as a duplicate key or a missing row, run it, see it fail, then remove the defect. A check that compares zero rows, skips because its input is missing, or reports `pass` with failures above zero proves nothing.
- Comments say why the code is the way it is. Leave out comments that restate the code.
- No linter or formatter runs here. Match the file you are in, and don't reformat lines you didn't change.
- Docs, comments and PR text use plain, short words and the active voice, as the existing docs do.

## Traps

- Some tracked files are generated and say nothing about it. Edit their generators: `ingestion/sources.json` comes from `pnpm -C ingestion generate-sources`, which you run after adding or renaming a source (pytest fails while the file is stale). `infra/grafana/dashboards/ingestion.json` and `pipeline.json` come from `infra/grafana/build_dashboards.py`.
- To rebuild part of the warehouse, run `bj run <pipeline> --select <key>`, where the key is a model name or `<source>/<table>`. A direct `dbt run` or `dbt build` on the warehouse leaves no trace in the run log, so `bj answer` cannot use it as proof of freshness. Direct dbt is fine in a check schema of your own (`DBT_SCHEMA=analytics_<name>_check`).
- `.env.example` must keep pointing at `localhost:5432` with user `elt`, password `elt` and database `warehouse`, because CI loads it as its environment.
- Under `answers/`, git tracks only `<slug>/question.yaml`. Commit it in the same PR as the analyses it names.

## Commits and pull requests

- Write the subject as one imperative sentence in sentence case, with no type prefix: `Keep fact statistics current`. The body says what changed and why. Title an analysis PR `Analysis: <question>`.
- Keep the `Co-Authored-By:` trailer on commits. Never put a Claude session link in a commit message or a pull request description: no `Claude-Session:` trailer and no `claude.ai/code/session_…` URL.
- The repo is public. Keep hosts, keys, private URLs and client names out of code, docs, commits and PRs. They belong in `.env` files, which git ignores.
- After each push, fix or answer every CodeRabbit and Copilot review thread. When you decline one, reply with the reason.

## Factory runs

Two unattended GitHub Actions runs, scope then build, turn analysis tickets into draft PRs. The labels `scope` and `ready-for-agent` start them. See `docs/agents/factory.md` and `docs/adr/0001-software-factory.md`. A factory run is one turn with no git, no gh and no background jobs. Its prompt in `.github/factory/` wins where it differs from this file.

# Per-run settings: implementation plan

> **For implementers:** work task by task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Read `AGENTS.md` before any task: assert arguments and results, put a limit on everything, pass library options at the call site, and say why in comments.

**Goal:** Whoever starts a pipeline run can set, for that run only, the env settings of each of its sources (aimed at one source, not every source that reads the same key) and dbt's vars and full refresh. The settings are Dagster run config on the ingestion assets and the dbt asset, so the CLI and Dagster's launchpad share one schema, Dagster checks the values, and the run keeps them.

**Architecture:** `pnpm generate-sources` also writes `ingestion/source-settings.json`: each source's env keys, read from its zod schema with `z.toJSONSchema`. Dagster builds each ingestion asset's config schema from that file, and the asset turns its config into extra env for its own `pnpm ingest`. The dbt asset takes `vars` and `full_refresh` as config and passes them to `dbt build`. `bj settings` reads the same file, and the env files in `loadEnv`'s order, in Python. `bj run --config` maps the file onto run config, checks it (names and types in Python, values against each source's own zod schema in one Node process, block ranges against the cursor, then Dagster's own check), and runs the job with that run config and a tag.

**Tech Stack:** zod v4 (`z.toJSONSchema`, `.meta()`), dotenv, tsx scripts in `ingestion/scripts/`; Dagster op config (`config_schema`, `dg.Config`), dagster-dbt; python-dotenv and PyYAML; pytest and `node:test`.

**Spec:** the contract below. Another client is built against it in parallel. This plan adds fields and options; it renames, removes and changes the meaning of nothing in it.

**Baseline:** `main` @ `b8f2402`. `uv run pytest tests/test_cli_run.py tests/test_sources_json.py` in `orchestration/` passes (35 tests).

## The contract

1. `bj settings <pipeline> --json` prints what can be set for one run of `<pipeline>` as JSON on stdout, exit 0:

   ```json
   {
     "pipeline": "polymarket",
     "sources": [
       {
         "name": "polygon.polymarket_ctf",
         "package": "polygon-polymarket-ctf",
         "settings": [
           {
             "key": "END_BLOCK",
             "type": "integer",
             "choices": null,
             "required": false,
             "secret": false,
             "value": "96000000",
             "description": null
           }
         ]
       }
     ],
     "dbt": {
       "vars": [{ "name": "coverage", "value": {} }],
       "full_refresh": { "supported": true }
     }
   }
   ```

   - `name` is `<source>.<table>` as in `ingestion/sources.json`.
   - `type` is one of `integer`, `number`, `string`, `boolean`, `enum` (`choices` set only for `enum`).
   - `value` is what a run would use now: the environment, else the package's env files in `loadEnv`'s order. It is always null for a secret.
   - Exit 2 for an unknown pipeline. A secret's value is never printed anywhere.

2. `bj run <pipeline> --config <file>`, where the file is JSON (YAML may also be accepted):

   ```json
   {
     "sources": { "polygon.polymarket_ctf": { "END_BLOCK": "96000000" } },
     "dbt": { "vars": { "coverage": {} }, "full_refresh": false }
   }
   ```

   - Every key is optional. Values under `sources` are strings, as env values are.
   - A source setting applies to that source only, for this run only, and wins over its env files and the process environment.
   - `dbt.vars` merge over `dbt_project.yml`'s vars and are passed to `dbt build`.
   - An unknown source, an unknown key, or a value the source's schema rejects makes it exit 2 before the run starts, naming each problem.
   - The settings used are recorded with the Dagster run, so the run history shows them.
   - Without `--config`, `bj run` behaves exactly as today.

**What this plan adds**, none of which changes the above:

- Each source in `bj settings` also has `kind` (`stream` or `call`). Each setting also has `per_run` (false when a run cannot set it, see Decisions 2 and 3), `default` (the schema's default as an env string, or null) and `value_from` (the repo path of the file that set `value`, or `environment`, or null).
- Without `--json`, `bj settings` prints the same as text for people.
- In `--config`, `""` unsets a key for this run, as an empty env value does for `loadEnv`.
- More reasons to exit 2, each a way the run could not do what the file asks: a secret, a `per_run: false` key set to something other than its current value, an `END_BLOCK` before `START_BLOCK` on a first run, an undeclared dbt var.
- Each problem prints on its own line: `bj: error: polygon.polymarket_ctf: END_BLOCK: must be a whole number, such as 96000000`. Warnings print as `bj: warning: …` and do not stop the run.
- The run gets a tag, `blockjuice/settings`, that lists the keys set, without values.

## What we know

Checked on 2026-11-09 against `main` @ `b8f2402`, by reading the code and with throwaway scripts outside the repo.

- **How env reaches a source.** `orchestration/pipeline/assets/ingestion.py` runs `pnpm --silent ingest` per asset with `env={**os.environ, "DAGSTER_RUN_ID": …, "CHAIN": source}`. `bj` loads the root `.env` into `os.environ` before any command (`pipeline/cli/__init__.py` `main`), and `bj dev` hands that environment to `dagster dev` (`cli/dev.py`). So root keys reach every source.
- **`loadEnv`'s order** (`ingestion/lib/src/env.ts`): dotenv `config({ path: ["chains/<CHAIN>/.env", "chains/<CHAIN>/.env.example", ".env"] })`, then empty values dropped. In dotenv 18.0.9's `populate`, the first file that sets a key wins, and no file overwrites a key already in `process.env`, even an empty one. So the first place that defines a key wins, even when empty, and empty means unset. A package's own `.env.example` is never read at run time. An extra `KEY=` in a subprocess's env therefore wins over every file and unsets the key.
- **Schemas export.** `z.toJSONSchema(source.env, …)` with the options of Decision 1 works for all 23 entries of `sources.json` (each `src/source.ts` imported, `forChain(chain)` called per chain folder, as the generator does). Output mode throws on the transforms in `startTime` and `blockNumber`. In input mode: `z.coerce.number().int()` gives `integer` with bounds; `z.enum` gives `string` with `enum`; `z.url()` gives `string`, format `uri`; `blockNumber` (`ingestion/lib/src/evm/env.ts`) and the candle sources' `START_TIME` give an `anyOf` of strings; `.default()` gives `default` and leaves the key out of `required`; `.refine()` is dropped. `.meta({ secret: true })` and `.describe()` survive `.optional()` on either side. `z.stringbool()` exports as a plain string.
- **Keys today.** Stream sources (7 packages: `arbitrum-token-bridge`, `evm-chainlink-price-feeds`, `evm-erc20-transfers`, `evm-op-standard-bridge`, `evm-uniswap-v2`, `-v3`, `-v4`): `PORTAL_URL`, `PORTAL_API_KEY`, `START_BLOCK`, and `END_BLOCK` in all but `evm-erc20-transfers`; the Uniswap packages add `POOLS_START_BLOCK` and `FACTORY_DB`, with a `.refine` that `POOLS_START_BLOCK <= START_BLOCK`. Call sources: `evmEnv` (`BLOCK_NUMBER`, `EVM_RPC_URL`, `RPC_BATCH_SIZE`, `RPC_MAX_CONCURRENCY`), the candle sources (`*_API_URL`, `CANDLE_INTERVAL` enum, `START_TIME`, `*_MAX_CONCURRENCY`), `DSHACKLE_URL`, `SOLANA_RPC_URL`. No schema uses `.describe()`; comments hold the descriptions. Nothing marks a secret.
- **Pipes and the cursor** (`@subsquid/pipes` 1.0.0-beta.11, `core/portal-source.ts` `read` and `core/query-builder.ts` `calculateRanges`, `applyRangeBound`). With a cursor at block C, Pipes clips the stream's range to start at C+1:
  - `START_BLOCK <= C` has no effect.
  - `START_BLOCK > C+1` is not clipped: the run skips blocks C+1 to `START_BLOCK`−1 and the cursor moves past them. `bj coverage` cannot see that hole.
  - `END_BLOCK <= C` leaves an empty range: the run loads nothing.
  - With no cursor, `END_BLOCK < START_BLOCK` throws `BlockRangeConfigurationError`.
  - `runSource` ends a run after about 1,000,000 blocks (`maxBlocksPerRun`). `_sync` keeps no first block.
- **`bj coverage`** reads `START_BLOCK` from the source folder's `.env`, else `.env.example` (`cli/coverage.py` `start_block`), and reports `covered: [START_BLOCK, cursor]`.
- **Dagster 1.13.28**, checked with an in-memory job:
  - An asset's op name is `AssetKey.to_python_identifier()`, such as `polygon__polymarket_ctf`.
  - `@dg.asset(config_schema={"END_BLOCK": dg.Field(dg.Noneable(dg.Int), is_required=False)})` works, and a run without config gets `{}`.
  - A `dg.Config` with `vars: dict[str, Any] = {}` takes nested values.
  - `execute_in_process(run_config=…, tags=…)` keeps both on the run.
  - `dg.validate_run_config(job, run_config)` raises `DagsterInvalidConfigError`, naming each unknown key and bad type, before any step runs.
  - `context.op_config` is deprecated; use `context.op_execution_context.op_config`.
  - Run tags are not strict: keys `[A-Za-z0-9_.-]` with one `/` namespace, values any string.
  - dagster-dbt 0.29.28 documents a `config: Config` parameter on a `@dbt_assets` function.
- **dbt.** `orchestration/pipeline/assets/dbt.py` runs `dbt.cli(["build"], context=context, raise_on_error=False)`. `transformation/dbt_project.yml` declares one var, `token`. `coverage` is read only as `var('coverage', {})` (`macros/erc20_balance_pairs.sql`, `tests/erc20_transfers_match_balances_has_pairs.sql`), and `bj answer` passes it with `--vars`. No model is incremental and there are no snapshots, so `--full-refresh` changes only how seeds load today. By dbt's documented precedence, `--vars` win over the project's vars by top-level name, so a var's value replaces the project's whole value.
- **Run history.** `bj run` uses the real Dagster instance only when `DAGSTER_HOME` is set; otherwise the run, and its config, live in memory and vanish.
- **Names.** `sources.json`'s `settings` field already means the chain's folder (`chains/<chain>`). This plan never uses that field for anything else.

## Decisions

1. **One exported file of settings.** The generator writes `ingestion/source-settings.json` next to `sources.json`, keyed by `<source>.<table>`. A separate file keeps `sources.json` and `read_sources` as they are. Each entry is `{kind, settings: [...]}`, and each setting holds `key, type, choices, required, secret, per_run, description, default`. A pure function in `ingestion/lib/src/settings.ts` turns a zod schema into that list through `z.toJSONSchema(env, { io: "input", target: "draft-2020-12", unrepresentable: "throw", cycles: "throw", reused: "inline" })`:
   - `integer` and `number` keep their JSON type; a string `enum` becomes `enum` with `choices` in schema order; `string`, and an `anyOf` whose branches are all strings, become `string`.
   - It refuses a JSON `boolean`: `z.coerce.boolean()` reads `"false"` as true, and plain `z.boolean()` cannot parse an env string. It refuses an object, an array or any other shape too. Each refusal names the key, so `pnpm generate-sources` fails the day a source adds one.
   - `required` is the schema's `required`; `default` is `String(default)`; `description` comes from `.describe()`.
   - The generator also refuses a schema that declares `CHAIN` or `DAGSTER_RUN_ID`, which the asset sets itself.
2. **Secrets come from schema metadata, with a naming rule as a guard.** A secret key carries `.meta({ secret: true })`. The generator refuses a key whose name ends in `_KEY`, `_SECRET`, `_TOKEN` or `_PASSWORD` unless its `secret` meta is set, true or false. Metadata alone fails silently when someone forgets it; a naming rule alone misses URLs that carry a key and flags harmless names. Together, each covers the other. This work marks `PORTAL_API_KEY` in the 7 stream packages, and `EVM_RPC_URL` and `SOLANA_RPC_URL` in `ingestion/lib`, since RPC URLs often hold a key in the path or query.

   A run cannot set a secret. Dagster keeps run config with the run and shows it in the run page and the launchpad, so a secret set there would be printed. The Dagster schema leaves secrets out, `bj settings` prints null for their `value` and `default`, and `--config` naming one exits 2 and points to the file to edit. `per_run` is false for every secret.
3. **`START_BLOCK` cannot change per run; `END_BLOCK` can.** `START_BLOCK` on every stream source, and `POOLS_START_BLOCK` and `FACTORY_DB` on the Uniswap packages, carry `.meta({ perRun: false })`. The generator refuses a stream source whose `START_BLOCK` lacks it. Why: with a cursor, a different `START_BLOCK` either does nothing or skips blocks; without one, the first run fixes where the source's history starts, while `bj coverage` keeps reading `START_BLOCK` from the env files. Either way the setting would not hold "for this run only".
   - `--config` may name a `per_run: false` key with the value the run would use anyway: `bj run` drops it as a no-op, so a client that sends back every value works. Any other value exits 2 with the file to edit, and "reset the source first" when it has a cursor. These keys are not in the Dagster schema, so the launchpad cannot set them either.
   - A per-run `END_BLOCK` is safe: the run stops there, and the next run resumes after the cursor. Before the run, `bj run` reads the cursor of each stream source with an `END_BLOCK` (`pipeline.warehouse.read_cursor`, read only). `END_BLOCK <= cursor` warns that the run loads nothing for that source. No cursor and `END_BLOCK` < the current `START_BLOCK` exits 2. An `END_BLOCK` more than about a million blocks past the cursor is reached only by later runs that set it again. The docs say so.
   - No path resets a cursor or deletes rows. A reset stays the manual step in `history-source.md`.
4. **A setting reaches one subprocess only.** The asset's op config becomes extra env for its own `pnpm ingest`: `env = {**os.environ, **overrides, "DAGSTER_RUN_ID": context.run_id, "CHAIN": source}`. A key already in the environment wins over every env file (fact above), so the override wins. `None` becomes `""`, which unsets the key for this run. Another source that reads the same key, such as `PORTAL_URL`, never sees it. `CHAIN` and `DAGSTER_RUN_ID` come last, and the asset asserts the overrides hold neither.
5. **Run config shape.** Each ingestion op takes a flat config of its `per_run` keys, all optional. `integer` → `dg.Int`, `number` → `dg.Float`, `string` → `dg.String`, `enum` → `dg.Enum` named `<source>__<table>__<KEY>` so two sources' enums never share a name in one job's config types. Each field is `dg.Field(dg.Noneable(type), is_required=False, description=…)`: omitted means no override, `null` means unset for this run. The dbt op takes `DbtRunConfig(vars: dict[str, Any] = {}, full_refresh: bool = False)`. The contract's file maps to:

   ```yaml
   ops:
     polygon__polymarket_ctf:
       config:
         END_BLOCK: 96000000
     transformation_assets:
       config:
         vars:
           coverage: {}
         full_refresh: false
   ```

   The op names come from `dg.AssetKey([source, table]).to_python_identifier()` and `transformation_assets.op.name`, never from a hand-built string. The file's strings become Dagster values: `""` → `None`; `integer` must match `^-?[0-9]+$`; `number` must parse as a finite float; `enum` must be one of `choices`; `string` passes as is. The asset turns them back with one function, `env_overrides`: `int` → `str`, `float` → `repr`, `None` → `""`.
6. **Checks before the run, in four phases.** `bj run --config` gathers every problem and exits 2 before any step:
   1. Shape, names and types, in Python: top-level keys `sources` and `dbt` only; each source is in this pipeline's job; each key is in its settings; each value is a string; `per_run` and type rules per Decisions 2, 3 and 5; dbt keys `vars` and `full_refresh` only, each var declared in `dbt_project.yml`, of the same top-level JSON type as there, and `full_refresh` a boolean.
   2. Values, against each source's own zod schema: one `pnpm --silent check-settings` process for every source that passed phase 1, fed the exact strings the asset will put in its env (built by `env_overrides` from the run config). Only zod knows the `.refine` rules, `z.url()` and coercion. It reports every problem of the source, including one in its env files, since the run would fail on it too.
   3. Block ranges against the cursor (Decision 3).
   4. `dg.validate_run_config(job, run_config)`. Phase 1 should leave it nothing to find; it guards the mapping.

   Phases 2 to 4 run on every source and key that passed phase 1, so one pass names all the problems it can find.
7. **`bj settings` reads values in Python, without Node.** It reads the files with `dotenv_values(path, interpolate=False)` (JS dotenv does not expand `${…}`) in `loadEnv`'s order: the environment `bj` sees (with the root `.env` loaded), `chains/<chain>/.env`, `chains/<chain>/.env.example`, the package `.env`. The first that defines a key wins, even when empty; empty gives `null`; a line with no `=` is skipped, as JS dotenv skips it. One JSON fixture, read by a TypeScript test and a Python test, holds the two in step. The pipeline's sources are the ingestion keys its job selects, resolved through Dagster as `test_every_asset_and_check_runs_in_a_scheduled_pipeline` does, after `dbt parse` as `bj run` does. `dbt.vars` lists `dbt_project.yml`'s vars with their values; `full_refresh.supported` is true when the job selects the dbt asset.
8. **The run keeps its settings.** Run config holds every value, and the run page and re-execution show and reuse it. The tag `blockjuice/settings` lists the keys set, such as `polygon.polymarket_ctf.END_BLOCK dbt.vars.coverage dbt.full_refresh` (the last only when true), so the runs list shows which runs changed what. Each ingestion step logs `Settings for this run: END_BLOCK=96000000`, and `bj run` prints the same before the run. With `DAGSTER_HOME` unset, `bj run --config` warns that Dagster keeps no record of the run.
9. **dbt.** `dbt_project.yml` declares `coverage: {}`, so every var the project reads is declared, and a test keeps it so. The asset builds `["build"]`, plus `["--vars", json.dumps(vars)]` when vars are set and `["--full-refresh"]` when asked. dagster-dbt still adds the job's own `--select`, so the job selection does not change: full refresh and vars touch only the pipeline's models and their upstream. The step also checks var names against `dbt_project.yml` before it calls dbt, since the launchpad skips phase 1.
10. **File format.** `.yaml` and `.yml` are read with `yaml.safe_load`, anything else as JSON. Values under `sources` must be strings in both, so YAML needs quotes: `END_BLOCK: "96000000"`. `bj run` reads at most 1 MiB of config.

## Interfaces

- `ingestion/source-settings.json`, written by `pnpm generate-sources`, sorted like `sources.json`:

  ```json
  {
    "arbitrum.token_bridge": {
      "kind": "stream",
      "settings": [
        { "key": "END_BLOCK", "type": "integer", "choices": null, "required": false, "secret": false,
          "per_run": true, "description": null, "default": null }
      ]
    }
  }
  ```

- `ingestion/lib/src/settings.ts` (zod declares `GlobalMeta` in `zod/v4/core`; augment it there, and let `pnpm typecheck` prove the keys reach `.meta()`):

  ```ts
  declare module "zod/v4/core" { interface GlobalMeta { secret?: boolean; perRun?: boolean } }
  export type SettingType = "integer" | "number" | "string" | "boolean" | "enum";
  export type Setting = { key: string; type: SettingType; choices: string[] | null; required: boolean;
    secret: boolean; per_run: boolean; description: string | null; default: string | null };
  export type SourceKind = "stream" | "call";
  export function settingsOf(env: z.ZodType, kind: SourceKind): Setting[];
  export type Problem = { key: string | null; message: string };
  export function envProblems(env: z.ZodType, values: Record<string, string>): Problem[];
  ```

  `boolean` stays in `SettingType` because the contract names it; `settingsOf` emits it only once a rule for boolean keys exists (open question 7).

- `ingestion/lib/src/env.ts` gains `readEnv(dir, chain, environment)`, which fills `environment` from the files in `loadEnv`'s order through dotenv's `processEnv` option and returns its non-empty values. `loadEnv` becomes `readEnv(process.cwd(), process.env.CHAIN, process.env)` plus validation, with the same effect on `process.env` as today.
- `pnpm check-settings` (`ingestion/scripts/check-settings.ts`). Stdin: `{"sources": [{"name": "polygon.polymarket_ctf", "env": {"END_BLOCK": "96000000"}}]}`, at most 1 MiB. It looks up each name's package and chain in `sources.json`. Stdout: `{"sources": [{"name": "…", "problems": [{"key": "END_BLOCK", "message": "…"}]}]}`. `key` is null for a rule over several keys. Exit 0 when it checked, 1 when it could not. Messages come from `safeParse(values, { reportInput: false })` and never hold a value.
- `orchestration/pipeline/run_settings.py`, pure apart from reading files:

  ```python
  SETTINGS_FILE = Path("ingestion/source-settings.json")

  @dataclass(frozen=True)
  class Setting:
      key: str
      type: str  # integer, number, string, boolean or enum
      choices: tuple[str, ...] | None
      required: bool
      secret: bool
      per_run: bool
      description: str | None
      default: str | None

  @dataclass(frozen=True)
  class SourceSettings:
      kind: str  # stream or call
      settings: tuple[Setting, ...]

  def read_settings(text: str) -> dict[str, SourceSettings]
  def current_value(repo_root: Path, entry: SourceEntry, key: str, environ: Mapping[str, str]) -> tuple[str | None, str | None]
  def config_schema(source: str, table: str, settings: SourceSettings) -> dict[str, dg.Field]
  def op_config(name: str, settings: SourceSettings, given: Mapping[str, object], current: Mapping[str, str | None]) -> tuple[dict[str, object], list[str]]
  def env_overrides(settings: SourceSettings, config: Mapping[str, object]) -> dict[str, str]
  def range_problems(name: str, start_block: int | None, end_block: int | None, cursor: int | None) -> tuple[list[str], list[str]]
  def dbt_var_problems(given: Mapping[str, object], declared: Mapping[str, object]) -> list[str]
  def settings_tag(run_config: Mapping[str, object]) -> str
  ```

- `BadInput` takes one or more problems; `main` prints each on its own line with today's prefix.

## Global Constraints

- Sources own their inputs. The Source contract, `runSource` and each package's `stream`/`extract` stay as they are; a run's settings reach a source only as env, through `loadEnv`. Schemas gain `.meta()` and nothing else.
- `loadEnv`'s effect on `process.env` and its errors stay the same; the existing `env.test.ts` passes unchanged.
- Without `--config`, `bj run` passes no run config and no tags, each source's env is exactly today's dict, and dbt gets exactly `["build"]`. A test pins each.
- Nothing resets a cursor, truncates a table or writes `_sync`.
- No secret value in stdout, stderr, run config, tags, step logs or `check-settings` output. Tests assert its absence.
- Prose in docs, help text and comments follows the repo's style: short words, active voice, the words in `GLOSSARY.md`.
- Work on a branch, not `main`. Commit after each task; keep the `Co-Authored-By` trailer, and put no session link in commits or PRs (`CLAUDE.md`).

## Review Focus

1. **A secret printed.** Through `bj settings`, a `--config` error, `check-settings`, run config, a tag or a step log. Tests: `test_a_secret_value_is_never_printed` (Task 10), `messages hold no input value` (Task 6), `test_a_secret_in_config_exits_2_without_echoing_it` (Task 11).
2. **A setting that reaches another source.** Two Uniswap sources both read `PORTAL_URL`. Test: `test_a_setting_reaches_only_its_own_source` (Task 8).
3. **`bj run` without `--config` changed.** Tests: `test_without_config_runs_as_today` (Task 11), `test_without_config_env_is_as_today` (Task 8), `test_build_args_without_config_are_as_today` (Task 9).
4. **Python and Node read env files differently,** so `bj settings` shows a value the run does not use. Test: the shared fixture (Tasks 5 and 7).
5. **A hole or a reset from block settings.** Tests: `test_start_block_unlike_the_current_value_exits_2`, `test_end_block_at_or_before_the_cursor_warns`, `test_end_block_before_start_block_on_a_first_run_exits_2` (Task 11).
6. **The checked string is not the string run.** Phase 2 must check the output of `env_overrides`, the same function the asset calls. Test: `test_check_settings_gets_the_env_the_asset_will_set` (Task 11).

---

### Task 1: Declare every dbt var

**Files:**
- Modify: `transformation/dbt_project.yml`
- Create: `orchestration/tests/test_dbt_project.py`

- [ ] **Step 1: Write the failing test** `test_every_var_the_project_reads_is_declared`: scan `models/`, `macros/`, `analyses/` and `tests/` for `var('<name>'` and `var("<name>"`, and assert each name is a key of `vars` in `dbt_project.yml`. Expected: FAIL, naming `coverage`.
- [ ] **Step 2:** Add `coverage: {}` under `vars`, with a comment: what each stream source has loaded, by `<source>.<table>`; `bj answer` passes it, and a scheduled build leaves it empty, so the reconciliation models build no rows.
- [ ] **Step 3:** Run the test and `uv run pytest tests/test_cli_answer.py` in `orchestration/`, then `set -a && . ./.env && set +a && cd transformation && uv run --project ../orchestration dbt parse` from the repo root. Expected: PASS, and the parse succeeds.
- [ ] **Step 4:** Commit: `Declare the coverage var in dbt_project.yml`

### Task 2: Settings from a zod schema

**Files:**
- Create: `ingestion/lib/src/settings.ts`, `ingestion/lib/src/settings.test.ts`

**Interfaces:** `settingsOf` and the `GlobalMeta` keys, per Interfaces and Decision 1.

- [ ] **Step 1: Write the failing tests:**
  - `integer, number, string and enum keys map to their types`: `z.coerce.number().int()`, `z.coerce.number()`, `z.url()`, `z.enum([...])` with its choices in order.
  - `an anyOf of strings is a string`: the `blockNumber` schema and a copy of the candle sources' `startTime`.
  - `a default or optional key is not required`.
  - `default is the env string of the schema's default`: `.default(5)` gives `"5"`; no default gives null.
  - `a secret is never per run`: `.meta({ secret: true })`, before and after `.optional()`.
  - `perRun false is kept, and description comes from describe()`.
  - `a key named like a secret needs secret meta`: a plain `PORTAL_API_KEY` throws naming it; `.meta({ secret: false })` passes.
  - `a stream source's START_BLOCK must not be per run`: throws for `kind: "stream"` without the meta; passes for `"call"`.
  - `CHAIN and DAGSTER_RUN_ID are refused`.
  - `a JSON boolean or an object is refused`: `z.coerce.boolean()` throws with a hint to use `z.stringbool()`; `z.object({...})` throws naming the key.
- [ ] **Step 2:** Run `pnpm --filter @ingestion/lib test`. Expected: FAIL.
- [ ] **Step 3:** Implement `settingsOf`. Assert the schema is an object and every property has a key; pass every `z.toJSONSchema` option at the call site.
- [ ] **Step 4:** Run the tests and `pnpm typecheck` in `ingestion/`. Expected: PASS.
- [ ] **Step 5:** Commit: `Read each source's settings from its zod env schema`

### Task 3: Mark secrets and keys a run cannot change

**Files:**
- Modify: `ingestion/lib/src/evm/env.ts` (`EVM_RPC_URL`), `ingestion/lib/src/solana/env.ts` (`SOLANA_RPC_URL`): `.meta({ secret: true })`
- Modify: `src/source.ts` of the 7 stream packages: `PORTAL_API_KEY` `.meta({ secret: true })`, `START_BLOCK` `.meta({ perRun: false })`
- Modify: `src/source.ts` of `evm-uniswap-v2`, `-v3`, `-v4`: `POOLS_START_BLOCK` and `FACTORY_DB` `.meta({ perRun: false })`

- [ ] **Step 1:** Add the metadata, each with a one-line comment saying why (the key holds a secret; the key fixes where the source's history starts and Pipes ignores it once a cursor exists).
- [ ] **Step 2:** Run `pnpm typecheck` and `pnpm --recursive --workspace-concurrency=1 test` in `ingestion/`. Expected: PASS, no behavior change.
- [ ] **Step 3:** Commit: `Mark secret env keys and keys a run cannot change`

### Task 4: The generator writes source-settings.json

**Files:**
- Create: `ingestion/scripts/packages.ts` (the discovery code moved out of the generator: `loadSources()` returns each entry with its Source object and `kind`, `"stream" in source ? "stream" : "call"`)
- Modify: `ingestion/scripts/generate-sources-json.ts`: an optional output folder in place of the output file; writes `sources.json` and `source-settings.json` there; asserts both list the same names
- Create: `ingestion/source-settings.json` (generated)
- Modify: `orchestration/tests/test_sources_json.py`, `orchestration/tests/test_cli_new_source.py` (the fake `pnpm` writes both files), `orchestration/pipeline/cli/new_source.py` (messages name both files)

- [ ] **Step 1: Write the failing tests** in `test_sources_json.py`:
  - `test_generated_files_are_fresh` replaces `test_sources_json_is_fresh`: run the generator into `tmp_path` and compare both files with the committed ones, naming the entries that drifted.
  - `test_source_settings_list_every_source_once`: its keys equal the `<source>.<table>` names of `sources.json`.
  - `test_stream_sources_fix_start_block`: each `kind: stream` entry has `START_BLOCK` with `per_run: false`. This pairs with the generator's own guard.
- [ ] **Step 2:** Run `uv run pytest tests/test_sources_json.py tests/test_cli_new_source.py`. Expected: FAIL.
- [ ] **Step 3:** Implement, then run `pnpm generate-sources` in `ingestion/`.
- [ ] **Step 4:** Run the tests and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit the scripts, both generated files and the tests: `Export each source's settings to ingestion/source-settings.json`

### Task 5: One rule for env order, in both languages

**Files:**
- Modify: `ingestion/lib/src/env.ts` (`readEnv`; `loadEnv` calls it), `ingestion/lib/src/env.test.ts`
- Create: `ingestion/lib/src/env-order.fixture.json`: cases of `{chain, environment, files, expected}`

The cases: the environment wins over every file; `chains/<chain>/.env` over its `.env.example` over the package `.env`; an empty value in an earlier place unsets the key; a `CHAIN` in a file is dropped; a line with no `=` is skipped; `${OTHER}` stays as written; an inline `# comment` and a quoted value.

- [ ] **Step 1: Write the failing test** `readEnv and loadEnv agree with the fixture`: for each case, build the folder in a temp dir, and check both `readEnv` on a copy of `environment` and `loadEnv` run from the folder.
- [ ] **Step 2:** Run `pnpm --filter @ingestion/lib test`. Expected: FAIL (`readEnv` missing).
- [ ] **Step 3:** Implement `readEnv` with dotenv's `processEnv` option, so there is one call to dotenv and one file order.
- [ ] **Step 4:** Run the tests. Expected: PASS, the old `loadEnv` tests unchanged.
- [ ] **Step 5:** Commit: `Read a source's env without touching process.env`

### Task 6: check-settings runs each source's own schema

**Files:**
- Modify: `ingestion/lib/src/settings.ts` (`envProblems`), `ingestion/lib/src/settings.test.ts`, `ingestion/package.json` (`"check-settings": "tsx scripts/check-settings.ts"`)
- Create: `ingestion/scripts/check-settings.ts`
- Create: `orchestration/tests/test_check_settings.py`

**Interfaces:** per Interfaces. For each source: `environment = {...process.env, ...env}`, `readEnv(packageDir, chain, environment)`, then `envProblems(source.env, values)`.

- [ ] **Step 1: Write the failing tests:**
  - lib: `a value the schema rejects names its key`; `a rule over two keys has a null key` (the Uniswap `POOLS_START_BLOCK <= START_BLOCK` refine); `messages hold no input value`: a failing value made of a marker string never appears in `JSON.stringify(problems)`.
  - Python, `test_check_settings_runs_the_sources_own_schema`: run the real script for `coinbase.candles` with `CANDLE_INTERVAL: "2m"` and a valid `START_TIME`, expect one problem keyed `CANDLE_INTERVAL`; skip when `pnpm` is missing, as `test_sources_json` does.
  - Python, `test_check_settings_refuses_an_unknown_name`: exit 1, the name in stderr.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `envProblems` with `safeParse(values, { reportInput: false })`, asserting no issue carries `input`, and the script on `loadSources()` and `readEnv`.
- [ ] **Step 4:** Run the lib tests, `pnpm typecheck` and the two Python tests. Expected: PASS.
- [ ] **Step 5:** Commit: `Check a run's source settings against each source's zod schema`

### Task 7: run_settings: values, Dagster schema and mapping

**Files:**
- Create: `orchestration/pipeline/run_settings.py`, `orchestration/tests/test_run_settings.py`

- [ ] **Step 1: Write the failing tests:**
  - `test_read_settings_rejects_a_malformed_file` (parametrized, as `test_read_sources_rejects_a_malformed_file`), including a setting named `CHAIN`.
  - `test_current_value_follows_the_shared_fixture`: every case of `env-order.fixture.json`, through `current_value`, gives `expected`, and `value_from` names the file or `environment`.
  - `test_config_schema_holds_only_per_run_keys`, `test_enum_types_are_named_per_source`, `test_every_field_is_optional_and_noneable`.
  - `test_op_config_converts_strings_by_type`: `"96000000"` → `96000000`, `""` → `None`, `"2m"` for an enum lacking it, `"1e6"` and `"12.5"` for an integer, and a non-string, each with its problem text.
  - `test_op_config_names_every_unknown_key_at_once`.
  - `test_a_per_run_false_key_equal_to_its_current_value_is_dropped` and `…_unlike_it_is_a_problem`; `test_a_secret_is_always_a_problem`.
  - `test_env_overrides_round_trip`: `op_config` then `env_overrides` gives back the canonical strings; `None` gives `""`.
  - `test_range_problems`: no cursor and `END_BLOCK < START_BLOCK` → a problem; cursor ≥ `END_BLOCK` → a warning; cursor below it → nothing.
  - `test_dbt_var_problems`: an undeclared var, a list where the project has an object, and `coverage: {}` passing.
  - `test_settings_tag_lists_keys_without_values`.
- [ ] **Step 2:** Run `uv run pytest tests/test_run_settings.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. Assert inputs at each function's top (known source, known keys, a `SourceSettings` read from the file) and the shape of each result.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit: `Map a run's settings between files, Dagster config and env`

### Task 8: Ingestion assets take run config

**Files:**
- Modify: `orchestration/pipeline/assets/ingestion.py`: `build_ingestion_asset` reads `source-settings.json` once at import, passes `config_schema`, builds the env with `env_overrides`, and logs the settings
- Create: `orchestration/tests/test_ingestion_assets.py`; modify `orchestration/tests/test_definitions.py`

- [ ] **Step 1: Write the failing tests:**
  - `test_each_asset_takes_its_sources_per_run_settings` (parametrized over `SOURCES`, in `test_definitions.py`): the asset's config fields equal the source's `per_run` keys.
  - `test_a_setting_reaches_only_its_own_source`: materialize `ethereum.uniswap_v2` and `ethereum.uniswap_v3` with `subprocess.run` replaced by a recorder; config sets `PORTAL_URL` on v2 only; v3's env holds the environment's value or none.
  - `test_without_config_env_is_as_today`: the env equals `{**os.environ, "DAGSTER_RUN_ID": run_id, "CHAIN": source}` exactly.
  - `test_null_unsets_for_this_run`: `END_BLOCK: null` gives `END_BLOCK=""`.
  - `test_chain_and_run_id_cannot_be_overridden`.
  - `test_step_log_names_the_settings`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Read config through `context.op_execution_context.op_config`.
- [ ] **Step 4:** Run `uv run pytest`. Expected: PASS, `test_every_asset_and_check_runs_in_a_scheduled_pipeline` included.
- [ ] **Step 5:** Commit: `Let each ingestion asset take its source's settings as run config`

### Task 9: The dbt asset takes vars and full refresh

**Files:**
- Modify: `orchestration/pipeline/assets/dbt.py`: `DbtRunConfig`, a pure `dbt_build_args(config)`, the var check at step start
- Create: `orchestration/tests/test_dbt_asset.py`

- [ ] **Step 1: Write the failing tests:**
  - `test_build_args_without_config_are_as_today`: `["build"]`.
  - `test_vars_pass_as_json`: `{"coverage": {}}` gives `["build", "--vars", "{\"coverage\": {}}"]`.
  - `test_full_refresh_adds_the_flag`.
  - `test_an_undeclared_var_fails_the_step_before_dbt_runs`: a `DbtCliResource` stand-in records whether `cli` was called.
  - `test_the_dbt_asset_takes_vars_and_full_refresh`: its config schema, from `defs`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `raise_on_error=False` and the `record_dbt_build` path as they are.
- [ ] **Step 4:** Run `uv run pytest`. Expected: PASS.
- [ ] **Step 5:** Commit: `Pass a run's dbt vars and full refresh to dbt build`

### Task 10: `bj settings`

**Files:**
- Create: `orchestration/pipeline/cli/settings.py`, `orchestration/tests/test_cli_settings.py`
- Modify: `orchestration/pipeline/cli/__init__.py` (the command, with help text and `--json`)

- [ ] **Step 1: Write the failing tests** on stubbed definitions, as `test_cli_run.py` stubs them, over a temp repo with `sources.json`, `source-settings.json` and env files for `polygon.polymarket_ctf`:
  - `test_prints_the_contract`: exit 0; the JSON has exactly the contract's keys at each level plus the added ones, and the example's values.
  - `test_unknown_pipeline_exits_2`: one line on stderr, nothing on stdout.
  - `test_a_secret_value_is_never_printed`: a marker value for `PORTAL_API_KEY` in the environment and in `.env`; `value` and `default` are null; the marker is in neither stdout nor stderr, with and without `--json`.
  - `test_dbt_lists_the_projects_vars`: `token` and `coverage` with their values.
  - `test_text_output_lists_each_setting`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement: `parse_project`, `load_definitions`, the job's ingestion keys in `sources.json` order, `current_value` per key.
- [ ] **Step 4:** Run `uv run pytest`. Expected: PASS.
- [ ] **Step 5:** Commit: `Add bj settings: what one run of a pipeline can set`

### Task 11: `bj run --config`

**Files:**
- Modify: `orchestration/pipeline/cli/run.py`, `orchestration/pipeline/cli/__init__.py` (`--config <file>`, help text, `BadInput` with several problems), `orchestration/tests/test_cli_run.py`

- [ ] **Step 1: Write the failing tests** on stubbed definitions whose assets carry the real config schemas built by `run_settings`:
  - `test_contract_example_runs_with_its_settings`: the contract's file, byte for byte; the stub assets see `END_BLOCK: 96000000`, `vars: {"coverage": {}}`, `full_refresh: False`; the run has that run config and the tag.
  - `test_without_config_runs_as_today`: `execute_in_process` gets `run_config=None` and no tags.
  - `test_problems_exit_2_before_any_step`: one file with an unknown source, an unknown key, a bad integer, a source not in the pipeline and an undeclared dbt var; each named on its own line; no stub asset ran.
  - `test_schema_problems_come_from_check_settings`: a faked `check-settings` reply becomes `bj: error:` lines.
  - `test_check_settings_gets_the_env_the_asset_will_set`: the faked process receives the output of `env_overrides`.
  - `test_a_secret_in_config_exits_2_without_echoing_it`.
  - `test_start_block_equal_to_the_current_value_is_dropped` and `test_start_block_unlike_the_current_value_exits_2`.
  - `test_end_block_at_or_before_the_cursor_warns` and `test_end_block_before_start_block_on_a_first_run_exits_2`, with `read_cursor` faked.
  - `test_yaml_config_needs_string_values`.
  - `test_warns_when_dagster_keeps_no_record`: `DAGSTER_HOME` unset.
- [ ] **Step 2:** Run `uv run pytest tests/test_cli_run.py`. Expected: FAIL.
- [ ] **Step 3:** Implement the four phases of Decision 6 in `run.py`, with `check-settings` run by `subprocess.run(["pnpm", "--silent", "check-settings"], cwd=INGESTION_DIR, input=…, capture_output=True, text=True, timeout=60)`. A timeout or exit 1 is a problem, not a crash. Read cursors only when a stream source sets `END_BLOCK`, after `require_env()`.
- [ ] **Step 4:** Run `uv run pytest`. Expected: PASS.
- [ ] **Step 5:** Commit: `Add bj run --config: one run's source and dbt settings`

### Task 12: Docs

**Files:**
- Modify: `README.md` ("How you use it": `bj settings` and `bj run --config`, one line each)
- Modify: `docs/architecture.md`: two rows in the command table, a new "Run settings" section (what a run can set, the file and its run config, `""`, secrets, `START_BLOCK` and `END_BLOCK` against the cursor, where the run keeps its settings, the launchpad), and in "Add a source" how to mark a key `secret` or `perRun: false` and that the generator writes `source-settings.json`
- Modify: `transformation/README.md` (declare every var in `dbt_project.yml`; set vars and full refresh per run)
- Modify: `GLOSSARY.md` (**Run settings**)
- Modify: `.claude/skills/blockjuice/workflows/history-source.md` (the "window ends after the cursor" bullet and step 7: `END_BLOCK` per run with `--config`; `START_BLOCK` still in the env file), `.claude/skills/blockjuice/workflows/new-pipeline.md` (the freshness test covers both generated files)

- [ ] **Step 1:** Write the docs. Every command shown is one a test runs.
- [ ] **Step 2:** Run `uv run --project orchestration bj settings --help` and `bj run --help` and check the help matches the docs.
- [ ] **Step 3:** Commit: `Document per-run settings`

## Risks

- **Two env parsers.** `bj settings` reads env files with python-dotenv, runs read them with JS dotenv. The fixture covers the cases the repo uses; an odd file could still differ, and `bj settings` would then show a value the run does not use. Runs stay right: phase 2 reads the files with the run's own code.
- **The launchpad checks less.** It runs Dagster's name and type checks only. A zod rule fails the step at its start with "Invalid environment", as today, and the cursor checks do not run, so an `END_BLOCK` at or before the cursor loads nothing and says so only in the step log.
- **Stricter than zod on numbers.** `"1e6"` and `"0x10"` pass `z.coerce.number()` but fail phase 1.
- **No boolean settings.** No source has one. `z.coerce.boolean()` reads `"false"` as true, and `z.stringbool()` exports as a string, so the generator refuses JSON booleans until open question 7 is settled.
- **Cost.** `bj settings` runs `dbt parse` (seconds) and imports the Dagster definitions. `bj run --config` adds one Node start for `check-settings` (about a second, more for sources that import Pipes). Setting vars makes dbt re-parse the whole project, since partial parsing keys on vars. The manifest that sets the job's selection is parsed without the run's vars, so a var that turned models on or off would not change what Dagster selects; none does today.
- **Branches in flight.** The polymarket sources live on their own branch. Whichever lands second must mark their `PORTAL_API_KEY` and `START_BLOCK` and regenerate both files; the generator refuses them until then.
- **Dagster's API.** `config_schema` on `@dg.asset` works in 1.13.28; if a later release drops it, a `dg.Config` model built per source replaces it.

## Open questions for the owner

1. **Secrets per run.** The plan refuses them, because run config is shown with the run. The other way: a CLI-only path that passes a secret out of band and records only that one was set; the launchpad could not use it.
2. **RPC URLs as secrets.** Marking `EVM_RPC_URL` and `SOLANA_RPC_URL` hides their values in `bj settings` and stops a run from switching RPC. Keep?
3. **`START_BLOCK` on a first run.** The plan refuses any change. Allowing it on a source with no cursor needs a place to record where its history really starts, which `bj coverage` would then read instead of the env file.
4. **`RAW_SCHEMA` per run.** The check-window flow in `history-source.md` loads into a throwaway raw schema. `RAW_SCHEMA` is not a source setting, and dbt reads it too, so this plan leaves it out. A follow-up?
5. **dbt vars.** Declare `coverage: {}` in `dbt_project.yml`, refuse undeclared vars, and refuse a top-level type unlike the project's?
6. **`DAGSTER_HOME` unset.** Warn (the plan), or refuse `--config`, since the settings would not be recorded anywhere?
7. **Boolean keys.** When a source needs one, mark it with `.meta({ type: "boolean" })` on a `z.stringbool()`, or another rule?
8. **Follow-ups, not in this plan:** move the comments above each env key into `.describe()`, so `description` and the launchpad carry them; rename `sources.json`'s `settings` to `folder`, so the word has one meaning; let `bj doctor` read required keys from `source-settings.json` instead of its hand list `OPTIONAL_KEYS`.

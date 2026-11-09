# Parallel `bj run`: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `bj run <pipeline>` runs the steps that do not depend on each other side by side, such as the Polymarket pipeline's `polymarket_ctf`, `polymarket_ctf_exchange_v2` and `markets` loads, without new ways to fail.

**Architecture:** `bj run` stops calling `execute_in_process`, whose executor runs one step at a time, and calls `dg.execute_job` on a reconstructable job. That uses the job's default multiprocess executor, the one scheduled runs already use. First, the warehouse takes an advisory lock around the tables each source creates when it opens, because Postgres's `IF NOT EXISTS` fails when sessions run it at the same moment.

**Tech Stack:** Dagster 1.13.28 (`build_reconstructable_job`, `execute_job`), `@ingestion/lib` on `pg`, Postgres 16, node:test, pytest.

**Spec:** the user's request of 2026-11-09: run the Polymarket pipeline's three loads in parallel, and deal with the downsides raised in the same conversation (empty-warehouse race, Portal load, tests, start-up cost, mixed logs). The two sections below are the rest of the spec.

**Branch:** the change touches every pipeline, not only Polymarket, so it goes on its own branch off `main`, not on PR #27's branch.

## Why the steps run one at a time today

`orchestration/pipeline/cli/run.py:41` calls `execute_in_process`, and that executor runs one step at a time whatever the job allows. The ingestion assets declare no `deps` on each other, and no source reads another's rows. Scheduled runs set no executor, so Dagster gives them the multiprocess one, and their steps already run side by side.

## The downsides, and what this plan does about each

Measured or read on 2026-11-09.

| Downside | Evidence | Plan |
|---|---|---|
| Sources that open at once on an empty warehouse fail. `open()` runs `create schema if not exists` and `create table if not exists <schema>._dead_letters`, and `IF NOT EXISTS` is not safe across sessions. | Three opens at once on an empty schema, 40 rounds on Postgres 16: all 40 rounds had a failed open (`23505` on `pg_namespace_nspname_index` and `pg_type_typname_nsp_index`). With `pg_advisory_xact_lock` around the same statements: no failures. | Task 1 |
| Pipes creates `<schema>._sync` the same way. | `getCursor` in `@subsquid/pipes/dist/targets/drizzle/node-postgres/postgres-state.js` sends its `CREATE TABLE IF NOT EXISTS` through `doWithRetry`: 3 retries, 50 ms apart, on any error. The retry finds the table the other session made. | Task 3, Step 1 |
| More load on Portal and the RPCs at once. | `portalClient` (`ingestion/lib/src/portal.ts`) retries HTTP 429 and 529 ten times, about two minutes, and both CTF sources use it. RPC sources go through eRPC, whose rate-limit budgets (`infra/erpc/erpc.yaml:80`) count all callers together. The largest pipelines, `balances` and `prices`, run 5 ingestion steps; the executor's default cap is the CPU count. | None; Review Focus 2 |
| The `bj run` tests swap in stub definitions with monkeypatch, which a step's own process never sees. | Prototype: step processes import a stub module found through `PYTHONPATH`. Two assets that each wait for the other passed in 1.7 s under the multiprocess executor and failed after 20 s under `execute_in_process`. | Task 2 |
| Each step starts its own process. | `import pipeline.definitions` took 1.6 to 1.9 s (three tries). Steps of one wave start together, so a run pays it about once per wave: loads, dead-letter checks, dbt. | None; Task 3 times the whole run |
| Logs from several steps mix. | Each Dagster line names the step key and the process id. An ingestion step logs its source's output in one block when `pnpm ingest` exits (`orchestration/pipeline/assets/ingestion.py`), so one source's lines stay together. | None |

Not done: a concurrency cap or a `--sequential` flag. Scheduled runs have run without one, and the shared limits above cover Portal and eRPC. Add one if Review Focus 2 turns up in practice.

## Global Constraints

- Dagster stays at 1.13.28 (`orchestration/uv.lock`); use only names `dagster` exports.
- The multiprocess executor needs a persistent instance. `bj` sets `DAGSTER_HOME` (`orchestration/pipeline/cli/__init__.py:224`); `orchestration/tests/conftest.py` sets one for tests.
- Python runs through `uv run` in `orchestration/`, TypeScript through `pnpm` in `ingestion/`, on Node 24 (`mise.toml`).
- Checks against Postgres use a throwaway container on port 55432. Port 5432 is the dev warehouse.
- Load real Polymarket data with `bj run` from a shell with direct network access to Portal and Gamma.

## Review Focus

1. First run on an empty warehouse: both CTF sources create `_sync` at the same moment. Expected: Pipes' retry handles it and both loads go on. Checked by Task 3, Step 1.
2. A source pointed straight at a public RPC, bypassing eRPC, that spaces its own requests (`RPC_MIN_INTERVAL_MS` on `solana-spl-balances`), running beside another source on the same endpoint. Each keeps its own spacing, so the endpoint sees the sum. Expected: refused calls become dead letters that the next run retries; the run does not crash. No test: this is the case that would justify a cap.
3. `bj run` started from a directory other than `orchestration/`. Expected: it works, because step processes import `pipeline.cli.run` from the installed package. Test: `test_runs_from_any_directory` in Task 2.
4. One load fails while others are still running. Expected: the others finish, dbt is skipped, and `bj run` exits 1 naming the failed step. Test: `test_a_failed_step_lets_the_others_finish` in Task 2.
5. Ctrl-C during a parallel run. Expected: no `tsx src/index.ts` process outlives `bj run`. Checked by Task 3, Step 4.

---

### Task 1: Warehouse tables created under an advisory lock

**Files:**
- Modify: `ingestion/lib/src/warehouse/index.ts:105-128` (the DDL in `open`)
- Create: `ingestion/lib/src/warehouse/concurrent-open.test.ts`
- Modify: `.github/workflows/ci.yml` (the `ingestion` job)

**Interfaces:**
- Consumes: `postgresWarehouse(settings?: WarehouseSettings)`, `WarehouseSettings`, `Connection` from `#src/warehouse/index.ts`.
- Produces: no new exports. `open()` keeps its signature.

- [ ] **Step 1: Write the failing test** `"warehouses that open at once on an empty schema all succeed"` in `concurrent-open.test.ts`.
  - Read `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER`, `WAREHOUSE_PASSWORD`, `WAREHOUSE_DB`. When one is unset, or a `pg.Client` cannot connect, call `t.skip(<reason>)` and return, as `orchestration/tests/test_warehouse.py` does.
  - Run 10 rounds. Each round uses a fresh schema `race_<round>_<random hex>`, a `postgresWarehouse({ schema, connect })` whose `connect` opens a new `pg.Client` per call (shaped like `postgresFromEnv` in `index.ts`), and `Promise.allSettled` over `open("source_0")`, `open("source_1")`, `open("source_2")`.
  - Assert per round:

    ```ts
    const failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
    assert.deepEqual(failed, []);
    ```
  - Close every handle that opened and `drop schema … cascade` each round, failed or not.

- [ ] **Step 2: Run it against a throwaway Postgres and watch it fail**

  ```bash
  docker run -d --rm --name bj-parallel-check -e POSTGRES_USER=elt -e POSTGRES_PASSWORD=elt -e POSTGRES_DB=warehouse -p 55432:5432 postgres:16
  cd ingestion/lib
  WAREHOUSE_HOST=localhost WAREHOUSE_PORT=55432 WAREHOUSE_USER=elt WAREHOUSE_PASSWORD=elt WAREHOUSE_DB=warehouse \
    pnpm exec tsx --test src/warehouse/concurrent-open.test.ts
  ```
  Expected: FAIL, the list naming `duplicate key value violates unique constraint "pg_namespace_nspname_index"` or `"pg_type_typname_nsp_index"`.

- [ ] **Step 3: Take the lock in `open()`**

  Run the three `create … if not exists` statements in one transaction that first runs `select pg_advisory_xact_lock(hashtext('ingestion.warehouse.ddl'))`. On error: `rollback`, then `close`, then rethrow. PGlite's `close` does nothing, so the rollback is what ends the transaction in the PGlite tests. One comment line says why: `IF NOT EXISTS` is not safe when sources open at once, and Dagster runs a pipeline's sources at once.

- [ ] **Step 4: Run the tests**

  Step 2's command: PASS. Then, from `ingestion/`: `pnpm --filter @ingestion/lib test` (PGlite tests pass; the new test skips) and `pnpm typecheck`.

- [ ] **Step 5: Run the new test in CI**

  Give the `ingestion` job the same `services: warehouse` block the `transformation-and-orchestration` job has, and add after "Test every package":

  ```yaml
      - name: Warehouse tests against Postgres
        working-directory: ingestion/lib
        env:
          WAREHOUSE_HOST: localhost
          WAREHOUSE_PORT: "5432"
          WAREHOUSE_USER: elt
          WAREHOUSE_PASSWORD: elt
          WAREHOUSE_DB: warehouse
        run: pnpm exec tsx --test src/warehouse/concurrent-open.test.ts
  ```
  The variables stay on this step, so no other package's tests see them.

- [ ] **Step 6: Commit**

  ```bash
  git add ingestion/lib/src/warehouse/index.ts ingestion/lib/src/warehouse/concurrent-open.test.ts .github/workflows/ci.yml
  git commit -m "fix(ingestion): create warehouse tables under a lock so sources can open at once"
  ```

### Task 2: `bj run` runs independent steps side by side

**Files:**
- Modify: `orchestration/pipeline/cli/run.py`
- Create: `orchestration/tests/stub_pipelines.py`
- Modify: `orchestration/tests/test_cli_run.py`
- Modify: `docs/architecture.md:150`

**Interfaces:**
- Consumes: Task 1 (sources may now open at once).
- Produces, in `pipeline/cli/run.py`:
  - `load_pipelines() -> tuple[str, Collection[str]]` replaces `load_definitions`. Returns `("pipeline.definitions", PIPELINES)`, importing `PIPELINES` inside the function as now, since `pipeline.schedules` needs the manifest `parse_project` writes.
  - `job_def(module: str, name: str) -> dg.JobDefinition`: `importlib.import_module(module).defs.resolve_job_def(name)`. Each step's process calls it to rebuild the job.
  - `materialize(module: str, pipelines: Collection[str], name: str) -> int`: same output and exit codes as today.

- [ ] **Step 1: Write the failing test**

  In `test_cli_run.py`, add two assets `a` and `b` and a job `side_by_side` selecting them; narrow `balances` from `selection="*"` to `[loaded, transformed]`. Each of `a` and `b` touches a file named after itself in `$STUB_BARRIER_DIR`, waits up to 20 s for the other's file, and otherwise raises `RuntimeError(f"{me} ran alone: {other} never started")`. A fixture `barrier` sets `STUB_BARRIER_DIR` to `tmp_path / "barrier"` and returns it; `stubbed` uses it and adds `side_by_side` to the pipeline names it returns. `test_unknown_pipeline_exits_2_listing_the_pipelines` now expects `pipelines: balances, loads, side_by_side`.

  ```python
  def test_runs_a_pipelines_steps_side_by_side(stubbed, capsys):
      assert main(["run", "side_by_side"]) == 0
      assert "side_by_side: run " in capsys.readouterr().out
  ```

- [ ] **Step 2: Run it and watch it fail**

  Run: `cd orchestration && uv run pytest tests/test_cli_run.py::test_runs_a_pipelines_steps_side_by_side -v`
  Expected: FAIL after about 20 s; the output has `ran alone`.

- [ ] **Step 3: Switch `bj run` to the job's own executor**

  - `materialize` builds `dg.build_reconstructable_job("pipeline.cli.run", "job_def", reconstructable_args=(module, name))` and runs it in `with dg.execute_job(job, instance=dg.DagsterInstance.get(), raise_on_error=False) as result:`. The result handling below that line stays as it is.
  - `run()` calls `load_pipelines()`. The module docstring says `bj run` runs independent steps side by side.
  - Move the stub assets and `Definitions` (named `defs`) to `orchestration/tests/stub_pipelines.py`. The `stubbed` fixture prepends the tests directory to `PYTHONPATH` (step processes inherit the environment and import the stub from there) and patches `run_command.load_pipelines` to return `("stub_pipelines", ["balances", "loads", "side_by_side"])`.

- [ ] **Step 4: Pin Review Focus 3 and 4**

  In `stub_pipelines.py`, add a job `one_fails` of two assets: `fails` raises `RuntimeError("source broke")`; `sibling` sleeps 2 s, then touches `$STUB_BARRIER_DIR/sibling`. Add `one_fails` to the fixture's pipeline names and to the list `test_unknown_pipeline_exits_2_listing_the_pipelines` expects.

  ```python
  def test_a_failed_step_lets_the_others_finish(stubbed, barrier, capsys):
      assert main(["run", "one_fails"]) == 1
      assert "step fails failed: RuntimeError: source broke" in capsys.readouterr().out
      assert (barrier / "sibling").exists()


  def test_runs_from_any_directory(stubbed, monkeypatch, tmp_path):
      monkeypatch.chdir(tmp_path)
      assert main(["run", "loads"]) == 0
  ```

- [ ] **Step 5: Run the tests**

  Run: `cd orchestration && uv run pytest tests/test_cli_run.py -v`
  Expected: all PASS, including `test_failed_run_exits_1_naming_the_failed_step` and the two `DAGSTER_HOME` tests, none of them changed. Then `uv run pytest`: PASS, with the warehouse tests skipping when no Postgres answers.

- [ ] **Step 6: Update the docs**

  `docs/architecture.md:150` becomes: "Runs one pipeline's Dagster job after `dbt parse`. Steps that do not depend on each other run side by side, as in scheduled runs."

- [ ] **Step 7: Commit**

  ```bash
  git add orchestration/pipeline/cli/run.py orchestration/tests/stub_pipelines.py orchestration/tests/test_cli_run.py docs/architecture.md
  git commit -m "feat(bj): run a pipeline's independent steps side by side"
  ```

### Task 3: Check on the real pipeline

No code. Run from the repo root, with direct network access, with Tasks 1 and 2 in place.

- [ ] **Step 1: `_sync` on an empty warehouse (Review Focus 1)**

  Start Task 1's container again if it stopped, load the ops schema, and start both CTF sources at the same moment, each writing its log to a scratch directory:

  ```bash
  docker exec -i bj-parallel-check psql -U elt -d warehouse < infra/postgres/ops.sql
  SCRATCH=$(mktemp -d)
  for p in polygon-polymarket-ctf polygon-polymarket-ctf-exchange-v2; do
    (cd ingestion/sources/$p && WAREHOUSE_PORT=55432 PUSHGATEWAY_URL= pnpm --silent ingest > "$SCRATCH/$p.log" 2>&1 &)
  done
  ```
  Once `select id from raw._sync` on port 55432 lists both sources, stop both processes. Expected: both ids listed; neither log has `23505`. Then remove the container.

- [ ] **Step 2: Run the pipeline**

  `uv run --project orchestration bj run polymarket`, in the background; the Gamma walk can take an hour. Expected: `polymarket: run <id> succeeded`.

- [ ] **Step 3: Show the loads overlapped**

  ```bash
  cd orchestration && DAGSTER_HOME=$PWD/.dagster_home uv run python -c "
  import sys, dagster as dg
  for e in dg.DagsterInstance.get().all_logs(sys.argv[1], of_type=dg.DagsterEventType.STEP_START):
      print(e.step_key, e.timestamp)
  " <run id>
  ```
  Expected: `polygon__polymarket_ctf`, `polygon__polymarket_ctf_exchange_v2` and `polymarket__markets` start within a few seconds of each other. Report the run's wall time, next to the last sequential `bj run polymarket` in the same history if there is one.

- [ ] **Step 4: Ctrl-C (Review Focus 5)**

  Start `bj run polymarket` in a terminal and press Ctrl-C once the three loads have started. Expected: within about 10 s, `pgrep -fl 'tsx src/index.ts'` prints nothing, and the Dagster UI shows the run as failed or canceled. If a load survives, stop and report before merging.

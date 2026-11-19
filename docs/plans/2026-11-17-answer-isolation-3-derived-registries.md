# Answer isolation 3: derive the registries

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four lists that people edit by hand come from a folder or a generated file that already states the same fact, so adding a pipeline or a source adds files and edits none that other work shares.

**Architecture:** `PIPELINES` is read from the folders under `models/marts/`. Intermediate models get one default materialization. The sources whose `wallets` key is optional come from each source's coverage contract in `ingestion/sources.json`. `bj new-source` writes a sources yml of its own for each table.

**Tech Stack:** Dagster and dagster-dbt (`pipeline/schedules.py`), dbt 1.12 project config, Python 3, pytest.

**Spec:** the contract below. It is step 3 of the answer isolation proposal of 2026-11-17. The four tasks do not depend on each other or on plans 1 and 2.

**Baseline:** `main` @ `43275a4`.

## The contract

1. A pipeline is a folder under `transformation/models/marts/` that holds at least one model. Its cron is `DEFAULT_CRON = "0 6 * * *"` unless `CRON_OVERRIDES` in `orchestration/pipeline/schedules.py` names it. An override that names no pipeline is an error when Dagster loads.
2. `dbt_project.yml` sets `+materialized: view` once for `intermediate`. No intermediate model is ephemeral. The four Polymarket models that set `materialized='table'` in their own file stay tables. The `accounts` and `hypercore` folders have no override today, so their models change from ephemeral to views and show as steps in Dagster.
3. A source's `wallets` key is optional when its coverage contract lists `wallets` under `unrestricted`. `OPTIONAL_WALLET_SOURCES` in `cli/coverage.py` goes. On `main` @ `43275a4` the two sets are equal: five pairs.
4. `bj new-source <source> <table>` writes `transformation/models/staging/<source>/_<source>__<table>__sources.yml` and edits no existing yml. dbt 1.12.6 accepts one source declared across several files: a scratch parse found all 32 sources. Existing `_<source>__sources.yml` files stay as they are.
5. A new seed gets a yml of its own beside it, `seeds/_<seed>__seeds.yml`. This is a rule in the docs. `seeds/_seeds.yml` stays.
6. `ingestion/sources.json` stays generated and tracked: Dagster reads it without Node.

## Global Constraints

- Use the terms in `GLOSSARY.md`: pipeline, mart, run. Never "job" for a run or "DAG" for a pipeline in new text.
- The repo is public. No hosts, keys, private URLs or client names in code, docs or commits.
- Commits: one imperative sentence in sentence case, no type prefix. Keep the `Co-Authored-By:` trailer. No session link.
- pytest needs a current `transformation/target/manifest.json`. After any change to `dbt_project.yml`, run `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`. Run pytest without `.env` exported.
- `Coverage`'s constructor keeps its field order: tests build it by position.
- Leave `bj dev` to the maintainer.

## Review Focus

1. A stray file or an empty folder under `models/marts/`, such as `.DS_Store` or a folder whose models moved away. Neither is a pipeline, and a job that selects nothing must not load. Pinned by `test_each_marts_folder_with_a_model_is_a_pipeline`.
2. A typo in `CRON_OVERRIDES`. The pipeline would run on the default cron and nobody would know. Pinned by `test_an_override_for_no_pipeline_is_an_error`.
3. A table that an existing `_<source>__sources.yml` already declares. `bj new-source` must refuse it, or dbt fails on the duplicate at the next parse. Pinned by `test_refuses_a_table_another_sources_file_already_has`.
4. A `Coverage` built without the new field, as most tests and the legacy path build it. It must treat no key as optional. Pinned by `test_missing_wallets_are_not_a_wildcard_without_the_contract`.
5. An intermediate model that a mart reads and that was ephemeral. As a view it becomes a relation in the warehouse, so a failed build of it now stops the mart. No test can pin a build: Task 2 ends with a real run of both pipelines.

## File structure

| File | Change |
|---|---|
| `orchestration/pipeline/schedules.py` | `pipelines()`, `DEFAULT_CRON`, `CRON_OVERRIDES`. The dict of 12 lines goes. |
| `transformation/dbt_project.yml` | Lines 27-57: one default, ten blocks fewer. |
| `orchestration/pipeline/cli/coverage.py` | `Coverage.unrestricted`. Lines 20-28 go. |
| `orchestration/pipeline/cli/new_source.py` | `plan()` writes a file per table. |
| Docs | Each file that tells a person to edit `PIPELINES` or `_<source>__sources.yml`. |

---

### Task 1: Read the pipelines from the marts folders

**Files:**
- Modify: `orchestration/pipeline/schedules.py:1-43`
- Test: `orchestration/tests/test_scheduling.py`
- Docs: `CLAUDE.md:37`, `README.md:575`, `transformation/CLAUDE.md:20`, `docs/architecture.md:238`, `.claude/skills/blockjuice/workflows/new-pipeline.md:3,29`, `.claude/skills/blockjuice/workflows/schedule-jobs.md`, `.claude/skills/blockjuice/workflows/report.md:43`, `orchestration/pipeline/cli/__init__.py:219-220`

**Interfaces:**
- Produces: `pipelines(marts_dir: Path, overrides: dict[str, str]) -> dict[str, str]`, sorted by name. Raises `ValueError(f"CRON_OVERRIDES names {name}, which is no folder of marts")`.
- Keeps: `PIPELINES: dict[str, str]`, `jobs`, `schedules`. `bj run` and the tests import them.

- [ ] **Step 1: Write the failing tests**

In `test_scheduling.py` (add `from pathlib import Path`, `import pytest`, and import `DEFAULT_CRON` and `pipelines` from `pipeline.schedules`):

```python
def test_each_marts_folder_with_a_model_is_a_pipeline(tmp_path):
    for name in ("dex", "balances"):
        (tmp_path / name).mkdir()
        (tmp_path / name / f"{name}.sql").write_text("select 1")
    (tmp_path / "empty").mkdir()
    (tmp_path / ".DS_Store").write_text("")
    assert pipelines(tmp_path, {"dex": "0 * * * *"}) == {"balances": DEFAULT_CRON, "dex": "0 * * * *"}


def test_an_override_for_no_pipeline_is_an_error(tmp_path):
    with pytest.raises(ValueError, match="CRON_OVERRIDES names bridges"):
        pipelines(tmp_path, {"bridges": "0 * * * *"})


def test_the_shipped_pipelines_are_the_marts_folders():
    marts = Path(__file__).resolve().parents[2] / "transformation" / "models" / "marts"
    assert PIPELINES.keys() == {folder.name for folder in marts.iterdir() if folder.is_dir()}
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_scheduling.py -q`
Expected: FAIL with `cannot import name 'pipelines'`.

- [ ] **Step 3: Implement**

In `schedules.py`, with `REPO_ROOT` from `pipeline.project`:

```python
MARTS_DIR = REPO_ROOT / "transformation" / "models" / "marts"
DEFAULT_CRON = "0 6 * * *"
# A pipeline that runs at another time gets an entry here: {"prices": "0 * * * *"}.
CRON_OVERRIDES: dict[str, str] = {}

PIPELINES = pipelines(MARTS_DIR, CRON_OVERRIDES)
```

The `daily` schedule uses `DEFAULT_CRON`.

- [ ] **Step 4: Run the tests**

Run: `uv run --project orchestration pytest orchestration/tests/test_scheduling.py orchestration/tests/test_definitions.py orchestration/tests/test_cli_run.py -q`
Expected: PASS. `PIPELINES` holds the same 12 names as before, now in sorted order.

- [ ] **Step 5: Update the docs**

In each file listed above, "add an entry to `PIPELINES`" becomes: a pipeline is a folder of marts, and `CRON_OVERRIDES` holds a cron only for one that does not run at 06:00 UTC. In `schedule-jobs.md`, replace the pasted dict with the three lines above and say that changing a cron is one entry in `CRON_OVERRIDES`.

- [ ] **Step 6: Commit**

```bash
git add orchestration/pipeline/schedules.py orchestration/pipeline/cli/__init__.py orchestration/tests/test_scheduling.py CLAUDE.md README.md transformation/CLAUDE.md docs/architecture.md .claude/skills/blockjuice/workflows
git commit -m "Read the pipelines from the marts folders"
```

---

### Task 2: One materialization for intermediate models

**Files:**
- Modify: `transformation/dbt_project.yml:27-57`, `transformation/CLAUDE.md:14`
- Test: `orchestration/tests/test_definitions.py`

- [ ] **Step 1: Write the failing test**

In `test_definitions.py` (add `import json` and `from pipeline.project import REPO_ROOT`):

```python
def test_no_intermediate_model_is_ephemeral():
    manifest = json.loads((REPO_ROOT / "transformation" / "target" / "manifest.json").read_text())
    kinds = {node["name"]: node["config"]["materialized"] for node in manifest["nodes"].values()
             if node["resource_type"] == "model" and node["fqn"][1] == "intermediate"}
    assert kinds
    assert sorted(name for name, kind in kinds.items() if kind == "ephemeral") == []
```

- [ ] **Step 2: Run it and see it fail**

Run `dbt parse` (see Global Constraints), then `uv run --project orchestration pytest orchestration/tests/test_definitions.py -q -k ephemeral`.
Expected: FAIL, listing the `accounts` and `hypercore` intermediate models.

- [ ] **Step 3: Change `dbt_project.yml`**

```yaml
    intermediate:
      # Views, never ephemeral, so each model shows as its own step in Dagster.
      +materialized: view
      polymarket:
        # Filters on jsonb staging columns keep the default selectivity, so the planner picks nested
        # loops that go quadratic on real loads; hash joins scale.
        +pre-hook: "set local enable_nestloop = off"
```

The other nine folder blocks under `intermediate` go, with their comments. The `marts` block is unchanged.

- [ ] **Step 4: Run the checks**

Run `dbt parse`, then `uv run --project orchestration pytest orchestration/tests/test_definitions.py orchestration/tests/test_scheduling.py -q`.
Expected: PASS. With a warehouse up, run `uv run --project orchestration bj run accounts` and `uv run --project orchestration bj run hypercore`. Expected: both end in success, and their intermediate models show as steps.

- [ ] **Step 5: Update the doc and commit**

`transformation/CLAUDE.md:14` becomes: staging and intermediate models build views and marts build tables; a new intermediate folder needs no entry in `dbt_project.yml`.

```bash
git add transformation/dbt_project.yml transformation/CLAUDE.md orchestration/tests/test_definitions.py
git commit -m "Build every intermediate model as a view"
```

---

### Task 3: Read the optional wallets key from the coverage contract

**Files:**
- Modify: `orchestration/pipeline/cli/coverage.py:20-28,37-52,129-137,256-304`
- Test: `orchestration/tests/test_cli_coverage.py:236-257`

**Interfaces:**
- Produces: `Coverage.unrestricted: frozenset[str] = frozenset()`, the last field. `read()` fills it from the source's contract in `sources.json`.

- [ ] **Step 1: Confirm the two sets are equal today**

```bash
uv run --project orchestration python -c "
from pathlib import Path
from pipeline.sources import SOURCES_FILE, read_sources
from pipeline.cli.coverage import OPTIONAL_WALLET_SOURCES
derived = {(e.name, e.table) for e in read_sources(Path(SOURCES_FILE).read_text())
           if 'wallets' in (e.coverage or {}).get('unrestricted', [])}
print(derived == OPTIONAL_WALLET_SOURCES, sorted(derived ^ OPTIONAL_WALLET_SOURCES))"
```

Expected: `True []`. If it prints `False`, stop: a source's contract and the constant disagree, and the maintainer decides which is right.

- [ ] **Step 2: Rewrite the two tests that read the constant**

Replace `test_known_all_wallet_sources_cover_a_requested_wallet` and `test_missing_wallets_are_not_a_wildcard_for_other_sources`, with their parameter lists:

```python
def test_a_source_whose_contract_leaves_wallets_optional_covers_a_requested_wallet():
    read = replace(loaded(), filter={"tokens": [USDC]}, unrestricted=frozenset({"wallets"}))
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == []
    assert read.gaps((100, 180), {"tokens": ["missing-token"]}) == ["tokens not in addresses.json: missing-token"]
    assert read.gaps((100, 180), {}, all_wallets=True) == []


def test_missing_wallets_are_not_a_wildcard_without_the_contract():
    read = replace(loaded(), filter={"tokens": [USDC]})
    assert read.gaps((100, 180), {"wallets": [WALLET]}) == ["addresses.json has no 'wallets'"]
    assert read.gaps((100, 180), {}, all_wallets=True) == [
        "unrestricted wallet coverage is unknown for ethereum.erc20_transfers"
    ]
```

Add one test of `read()`. Copy the setup of `test_read_expects_coin_names_in_the_case_ingestion_recorded`, which writes a `sources.json` with the `FILLS` contract and fakes the warehouse reads, and end it with:

```python
    assert coverage.read(repo, "hypercore.fills").unrestricted == frozenset({"users", "coins"})
```

- [ ] **Step 3: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_coverage.py -q -k "optional or wildcard or unrestricted"`
Expected: FAIL with `unexpected keyword argument 'unrestricted'`.

- [ ] **Step 4: Implement**

Add the field. In `gaps`, the two `(self.source, self.table) in OPTIONAL_WALLET_SOURCES` tests become `"wallets" in self.unrestricted`. In `read()`, pass `optional_wallets="wallets" in contract.get("unrestricted", [])` to `address_filter`, and `unrestricted=frozenset(contract.get("unrestricted", []))` to `Coverage`. Delete the constant and its comment.

- [ ] **Step 5: Run the tests and commit**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_coverage.py orchestration/tests/test_cli_answer.py -q`
Expected: PASS. A test that builds a `Coverage` by hand for one of the five sources and relied on the constant now passes `unrestricted=frozenset({"wallets"})`.

```bash
git add orchestration/pipeline/cli/coverage.py orchestration/tests/test_cli_coverage.py orchestration/tests/test_cli_answer.py
git commit -m "Read the optional wallets key from the coverage contract"
```

---

### Task 4: A sources yml for each new table

**Files:**
- Modify: `orchestration/pipeline/cli/new_source.py:126-145`, `orchestration/pipeline/cli/__init__.py:213-221`
- Test: `orchestration/tests/test_cli_new_source.py:80-131,272-284`, `orchestration/tests/test_sources_json.py:77-79`
- Docs: `transformation/CLAUDE.md:10`, `transformation/README.md:9`, `docs/architecture.md:213-216`, `.claude/skills/blockjuice/workflows/new-pipeline.md:16`, `.claude/skills/blockjuice/workflows/state-source.md:11`

**Interfaces:**
- Changes: `plan()` puts `staging/<source>/_<source>__<table>__sources.yml` in `Plan.files`, with the text `sources_yaml(source, table)` already returns. It refuses with `BadInput(f"{path} already has table {table!r}")` when any `_*__sources.yml` in the folder declares the table, naming that file.

- [ ] **Step 1: Change the tests**

In `test_cli_new_source.py`:

- `test_adds_a_table_to_an_existing_source`: the existing `_ethereum__sources.yml` is byte-for-byte what it was, the new file `_ethereum__<table>__sources.yml` equals `new_source.sources_yaml("ethereum", <table>)`, and the output names the new file as created, where it named the old one as changed.
- `test_creates_the_sources_file_of_a_new_source`: the file is `_optimism__<table>__sources.yml`.
- Rename `test_refuses_a_table_the_sources_file_already_has` to `test_refuses_a_table_another_sources_file_already_has`. It still expects `BadInput` that names `_ethereum__sources.yml`.
- Delete `test_refuses_a_sources_file_where_the_table_would_land_under_another_source`: no file is appended to any more.

Add:

```python
def test_a_new_table_is_declared_once_across_the_sources_files(repo, pnpm):
    assert new_source.run(repo, "ethereum", "blob_fees", "evm-eth-balances") == 0
    staging = repo / "transformation/models/staging/ethereum"
    declared = [table for yml in sorted(staging.glob("_*__sources.yml"))
                for table in new_source.source_tables(yml.read_text(), "ethereum", yml)]
    assert "blob_fees" in declared and len(declared) == len(set(declared))
```

Use the `--like` package and the call shape the file's other tests use.

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_new_source.py -q`
Expected: the changed tests fail, since `plan()` still appends to `_ethereum__sources.yml`.

- [ ] **Step 3: Implement, and fix the message in `test_sources_json.py`**

Change `plan()` as the interface says. In `test_sources_json.py:77-79`, the failure text names `a _*__sources.yml in transformation/models/staging/<name>/`, since the table may sit in either kind of file. `dbt_source_tables()` already reads every `_*__sources.yml`.

- [ ] **Step 4: Run the tests**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_new_source.py orchestration/tests/test_sources_json.py -q`
Expected: PASS.

- [ ] **Step 5: Update the docs and commit**

The help text of `bj new-source` and the five docs say it adds `_<source>__<table>__sources.yml`. `transformation/CLAUDE.md:10` gains the seed rule of contract item 5.

```bash
git add orchestration transformation/CLAUDE.md transformation/README.md docs/architecture.md .claude/skills/blockjuice/workflows
git commit -m "Write a sources yml for each new table"
```

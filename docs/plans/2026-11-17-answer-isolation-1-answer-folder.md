# Answer isolation 1: each answer holds its analyses

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An answer's analyses and its own macros live in `answers/<slug>/`, dbt reads them through two paths that `bj answer` sets, and a question's subject is written once, in `question.yaml`.

**Architecture:** `dbt_project.yml` takes its analysis path and a second macro path from two env vars. `bj answer` sets both to the answer it runs, around each dbt call, so every compile sees one answer. `bj questions` reads the same folders. The `inputs` dbt var carries each named input's filter, and the `input_values` macro prints one as a SQL list.

**Tech Stack:** dbt 1.12 (`env_var` in `dbt_project.yml`), Python 3 (`pipeline/cli`, `pipeline/analysis`), pytest, GitHub Actions.

**Spec:** the contract below. It is step 1 of the answer isolation proposal of 2026-11-17, with the recommended layout. Plans 2 to 5 in this folder build on it.

**Baseline:** `main` @ `43275a4`.

## The contract

1. An answer folder tracks three things: `question.yaml`, `analyses/` and `macros/` (optional). Everything else under `answers/<slug>/` stays ignored. Plan 4 adds `reference.csv`.
2. `transformation/dbt_project.yml` reads:

   ```yaml
   macro-paths: ["macros", "{{ env_var('BJ_MACROS', 'question-macros') }}"]
   analysis-paths: ["{{ env_var('BJ_ANALYSES', 'analyses') }}"]
   ```

   Neither default folder exists after this plan. dbt 1.12.6 accepts a missing folder: a scratch parse found 0 analyses, 100 models and 32 sources.
3. `bj answer <slug>` sets `BJ_ANALYSES=../answers/<slug>/analyses` and `BJ_MACROS=../answers/<slug>/macros`, as paths from the dbt project, around its dbt compile and its dbt test, and restores the environment after each.
4. An analysis name is unique inside one answer only. The first analysis of every answer is `headline`. `analyses` in `question.yaml` defaults to `[headline]`.
5. `bj answer` passes the dbt var `inputs`: `{<input name>: {<filter key>: [values]}}`, for each input that has a `name` and a `filter`. A value that is `0x` hex goes lowercase, since staging lowercases EVM addresses. Any other value passes as written. `{{ input_values('<input>', '<key>') }}` prints the list as `('a', 'b')`.
6. `bj questions --check` fails when an answer holds an analysis its `question.yaml` does not name, and when `transformation/analyses/` still holds a `.sql` file.

Not in this plan: the two macros that serve one question each (`attributed_eth_flows.sql`, `labelled_flows.sql`) stay in `transformation/macros/`. The reference tests in `transformation/tests/reference/` call them, and CI compiles those tests without `BJ_MACROS`. Plan 4 deletes the tests and moves the macros.

## Global Constraints

- Use the terms in `GLOSSARY.md`: answer, analysis, mart, pipeline, check. Never "query" for an analysis in new text.
- The repo is public. No hosts, keys, private URLs or client names in code, docs or commits.
- Commits: one imperative sentence in sentence case, no type prefix. Keep the `Co-Authored-By:` trailer. No session link.
- Run every command from the repo root. dbt needs `.env` exported: `set -a && . ./.env && set +a && <command>`. Run pytest without it exported.
- Change what the task names. No refactor of nearby code.
- The maintainer's checkout holds untracked answers. Never delete or rewrite a file that git does not track.

## Review Focus

1. An answer with no `macros/` folder. `BJ_MACROS` then names a missing folder, and the answer must still compile. Pinned by the CI loop in Task 1 and the compile test in Task 3.
2. Two answers that both have `headline.sql`. Neither may see the other's file. Pinned by `test_two_answers_may_use_the_same_analysis_name`.
3. An analysis that a branch cut before this change adds to `transformation/analyses/`. After a merge it would never run. `bj questions --check` must fail and name it. Pinned by `test_check_catches_an_analysis_left_in_the_dbt_project`.
4. `bj answer` failing between its two dbt calls. `BJ_ANALYSES` must not stay set, or the next dbt command in the same process reads one answer's folder. Pinned by `test_question_paths_restore_the_environment_after_a_failure`.
5. A checksummed EVM address in a filter. Marts hold lowercase, so a mixed-case literal matches no row and the answer is a silent zero. Pinned by `test_input_filters_lowercase_hex_and_keep_other_values`.

## File structure

| File | Change |
|---|---|
| `transformation/dbt_project.yml` | Lines 8 and 10 read the two env vars. |
| `orchestration/pipeline/cli/answer.py` | New `question_paths`. `provenance` counts an answer's tracked files. |
| `orchestration/pipeline/analysis/runner.py` | Wraps both dbt calls in `question_paths`. Passes the `inputs` var. |
| `orchestration/pipeline/analysis/compiler.py` | The error at line 37 names the answer's folder. |
| `orchestration/pipeline/analysis/specification.py` | New `input_filters`. `analyses` defaults to `[headline]`. |
| `orchestration/pipeline/analysis/spec.py` | `inputs` joins `RESERVED`. |
| `orchestration/pipeline/cli/catalog.py` | Reads `answers/<slug>/analyses/`. New `--check` rules. |
| `orchestration/pipeline/demo.py` | Copies the answer's `analyses/` beside its `question.yaml`. |
| `transformation/macros/inputs.sql` | New: `input_values`. |
| `answers/*/analyses/*.sql` | The 56 tracked analyses, moved from `transformation/analyses/`, then renamed. |
| `.gitignore`, `.github/workflows/ci.yml` | Track the two folders. Compile each answer. |

---

### Task 1: Move the analyses and point dbt at them

One change, because every half of it breaks `bj answer` alone.

**Files:**
- Modify: `transformation/dbt_project.yml:8,10`, `.gitignore:22-26`, `.github/workflows/ci.yml:132-137`
- Modify: `orchestration/pipeline/cli/answer.py`, `orchestration/pipeline/analysis/runner.py:58-72`, `orchestration/pipeline/analysis/compiler.py:37`, `orchestration/pipeline/cli/catalog.py`, `orchestration/pipeline/demo.py:184-186`
- Move: `transformation/analyses/*.sql` to `answers/<slug>/analyses/`
- Test: `orchestration/tests/test_cli_catalog.py`, `orchestration/tests/test_cli_answer.py`, `orchestration/tests/test_analysis_rules.py:54,77,105`

**Interfaces:**
- Produces, in `pipeline/cli/answer.py`: `question_paths(project: Path, folder: Path) -> ContextManager[None]`. `project` is the dbt project folder and `folder` is `answers/<slug>`. Inside the block `BJ_ANALYSES` and `BJ_MACROS` hold the POSIX paths from `project` to `folder/analyses` and `folder/macros`. On exit, also after an exception, both hold what they held before, or are unset.
- Produces, in `pipeline/cli/catalog.py`: `analysis_paths(repo_root: Path, slug: str) -> dict[str, str]`, each analysis under `answers/<slug>/analyses/` by name, with its path from the repo root. It replaces `analysis_paths(repo_root)`.

- [ ] **Step 1: Rewrite the catalog tests**

In `test_cli_catalog.py`, add a helper and change the tests that write to `transformation/analyses/`:

```python
def write_analysis(root, slug, name, sql="select 1"):
    path = root / "answers" / slug / "analyses" / f"{name}.sql"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(sql)
    return path


def test_lists_question_and_its_authored_queries_without_warehouse(tmp_path, capsys):
    make_question(tmp_path)
    write_analysis(tmp_path, "sample", "nested/sample")
    assert run(tmp_path, None, as_json=True) == 0
    document = json.loads(capsys.readouterr().out)
    assert document[0]["analyses"] == [{"name": "sample", "path": "answers/sample/analyses/nested/sample.sql"}]


def test_rejects_missing_and_ambiguous_queries(tmp_path):
    make_question(tmp_path)
    with pytest.raises(BadInput, match="no SQL analysis named sample in answers/sample/analyses"):
        catalog(tmp_path)
    write_analysis(tmp_path, "sample", "sample")
    write_analysis(tmp_path, "sample", "other/sample", "select 2")
    with pytest.raises(BadInput, match="duplicate SQL analysis name sample"):
        catalog(tmp_path)


def test_check_catches_an_analysis_its_question_does_not_name(tmp_path, capsys):
    make_question(tmp_path)
    write_analysis(tmp_path, "sample", "sample")
    write_analysis(tmp_path, "sample", "orphan")
    assert run(tmp_path, None, check=True) == 1
    assert "answers/sample/analyses/orphan.sql" in capsys.readouterr().out


def test_check_catches_an_analysis_left_in_the_dbt_project(tmp_path, capsys):
    make_question(tmp_path)
    write_analysis(tmp_path, "sample", "sample")
    old = tmp_path / "transformation" / "analyses" / "old.sql"
    old.parent.mkdir(parents=True)
    old.write_text("select 1")
    assert run(tmp_path, None, check=True) == 1
    assert "transformation/analyses/old.sql" in capsys.readouterr().out


def test_two_answers_may_use_the_same_analysis_name(tmp_path):
    for slug in ("one", "two"):
        make_question(tmp_path, slug, "[headline]")
        write_analysis(tmp_path, slug, "headline")
    assert run(tmp_path, None, check=True) == 0


def test_every_shipped_analysis_is_named_by_its_question():
    root = Path(__file__).resolve().parents[2]
    for entry in catalog(root):
        folder = root / "answers" / entry["slug"] / "analyses"
        assert sorted(q["name"] for q in entry["analyses"]) == sorted(p.stem for p in folder.rglob("*.sql"))
    assert list((root / "transformation" / "analyses").glob("**/*.sql")) == []
```

Delete `test_check_catches_queries_without_a_question` and `test_every_repository_analysis_belongs_to_one_supported_question`: the four tests above replace them. In `test_aligned_token_override_and_separate_eval_values`, write the analyses with `write_analysis(tmp_path, "token-flow-map", name)`.

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_catalog.py -q`
Expected: the six tests above fail, most with `no SQL analysis named`.

- [ ] **Step 3: Change `catalog.py`**

`catalog()` calls `analysis_paths(repo_root, slug)` per question. A name with no file raises `BadInput(f"{manifest}: no SQL analysis named {name} in answers/{slug}/analyses")`. Under `--check`, `run` prints one line per analysis file its `question.yaml` does not name, one line per `.sql` under `transformation/analyses/` (`<path>: move it into its answer's analyses/ folder`), and returns 1 when it printed any. The ownership map and the "belongs to multiple questions" message go: the layout makes both impossible. Keep the last line, `Validated <n> questions covering <m> SQL analyses.`

- [ ] **Step 4: Write the tests for the dbt paths**

In `test_cli_answer.py` (add `import os`):

```python
def test_question_paths_point_dbt_at_one_answer_and_restore_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("BJ_ANALYSES", "before")
    monkeypatch.delenv("BJ_MACROS", raising=False)
    with answer.question_paths(tmp_path / "transformation", tmp_path / "answers" / "eth-total"):
        assert os.environ["BJ_ANALYSES"] == "../answers/eth-total/analyses"
        assert os.environ["BJ_MACROS"] == "../answers/eth-total/macros"
    assert os.environ["BJ_ANALYSES"] == "before"
    assert "BJ_MACROS" not in os.environ


def test_question_paths_restore_the_environment_after_a_failure(tmp_path, monkeypatch):
    monkeypatch.delenv("BJ_ANALYSES", raising=False)
    with pytest.raises(BadInput):
        with answer.question_paths(tmp_path / "transformation", tmp_path / "answers" / "eth-total"):
            raise BadInput("dbt compile failed")
    assert "BJ_ANALYSES" not in os.environ


def test_bj_answer_runs_dbt_inside_the_answers_own_paths(tmp_path, offline, monkeypatch):
    write_question(tmp_path)
    offline(parked=0)
    seen = []

    def compile_analyses(project, names, blocks):
        seen.append(("compile", os.environ.get("BJ_ANALYSES"), os.environ.get("BJ_MACROS")))
        return MANIFEST, ["analysis.t.holders"]

    def run_dbt_tests(project, names, coverages, upstream=(), **kwargs):
        seen.append(("test", os.environ.get("BJ_ANALYSES"), os.environ.get("BJ_MACROS")))
        return Check("dbt_tests", True, "3 passed")

    monkeypatch.setattr(answer, "compile_analyses", compile_analyses)
    monkeypatch.setattr(answer, "run_dbt_tests", run_dbt_tests)
    assert answer.run(tmp_path, "eth-total") == 0
    paths = ("../answers/eth-total/analyses", "../answers/eth-total/macros")
    assert seen == [("compile", *paths), ("test", *paths)]
    assert "BJ_ANALYSES" not in os.environ
```

Change the match in `test_an_analysis_dbt_does_not_know_is_bad_input` to `"write analyses/eth_total.sql in the answer's folder"`.

- [ ] **Step 5: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_answer.py -q -k "question_paths or own_paths or does_not_know"`
Expected: FAIL with `module 'pipeline.cli.answer' has no attribute 'question_paths'`.

- [ ] **Step 6: Add `question_paths`, wire the runner, change the message**

`question_paths` goes in `cli/answer.py` beside `dbt()`. In `runner.run`, wrap the `api.compile_analyses(...)` call and the `api.run_dbt_tests(...)` call each in `with api.question_paths(project, repo_root / "answers" / slug):`. The paths always come from `answers/<slug>`, never from its `eval/` folder. In `compiler.py:37` the message becomes `no dbt analysis named {name}: write analyses/{name}.sql in the answer's folder`.

- [ ] **Step 7: Change `dbt_project.yml` and `.gitignore`**

Lines 8 and 10 of `dbt_project.yml` as in the contract. In `.gitignore`, after `!answers/*/question.yaml`:

```gitignore
!answers/*/analyses/
!answers/*/macros/
```

Update the comment above the block to name the three tracked things.

- [ ] **Step 8: Move the files**

Save this as a file outside the repo, run it once with `uv run --project orchestration python <file> .`, and do not commit it:

```python
"""Moves each analysis into its answer's folder, as question.yaml names it."""
import subprocess
import sys
from pathlib import Path

import yaml

root = Path(sys.argv[1]).resolve()
source = root / "transformation" / "analyses"
listed = subprocess.run(["git", "-C", str(root), "ls-files", "transformation/analyses"],
                        capture_output=True, text=True, check=True).stdout.split()
for question in sorted((root / "answers").glob("*/question.yaml")):
    target = question.parent / "analyses"
    target.mkdir(exist_ok=True)
    for name in yaml.safe_load(question.read_text())["analyses"]:
        file = source / f"{name}.sql"
        if not file.is_file():
            print(f"missing: {question.parent.name} names {name}")
        elif file.relative_to(root).as_posix() in listed:
            subprocess.run(["git", "-C", str(root), "mv", str(file), str(target / file.name)], check=True)
        else:
            file.rename(target / file.name)
print("left:", sorted(p.name for p in source.glob("*.sql")))
```

Expected: no `missing:` line, and `left: []`. Then `git rm transformation/analyses/.gitkeep`, so the old folder goes and nobody adds to it.

- [ ] **Step 9: Fix the other readers**

- `demo.py`: after it copies `question.yaml`, copy `answers/<slug>/analyses` to `destination / "analyses"` with `shutil.copytree`.
- `test_analysis_rules.py`: `analyses_writing_their_window` reads `root / "answers" / slug / "analyses" / f"{name}.sql"`, and `make_question` and the test at line 105 write there.
- `answer.py` `provenance`: the second `git status` call also takes `":(glob)answers/*/analyses/**"` and `":(glob)answers/*/macros/**"`, so an edited analysis makes `git_dirty` true.
- `ci.yml`: after the `dbt parse, seed and compile` step, add:

  ```yaml
      - name: Compile each answer's analyses
        run: |
          for folder in ../answers/*/; do
            names=$(cd "${folder}analyses" && ls *.sql | sed 's/\.sql$//' | tr '\n' ' ')
            BJ_ANALYSES="${folder}analyses" BJ_MACROS="${folder}macros" \
              uv run --project ../orchestration dbt compile --quiet --select $names
          done
        working-directory: transformation
  ```

- [ ] **Step 10: Run every check**

```bash
set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation
uv run --project orchestration bj questions --check
```

Expected: parse succeeds, and `Validated 13 questions covering 56 SQL analyses.` Then, in a shell without `.env` exported: `uv run --project orchestration pytest`. Expected: all pass. With a warehouse up, run `uv run --project orchestration bj answer tracked-wallets-eth` and expect the value it gave before the move.

- [ ] **Step 11: Update the docs that name the old folder**

Each of these says analyses live in `transformation/analyses/`. Change them to `answers/<slug>/analyses/`: `CLAUDE.md:39` and its trap about tracked files under `answers/`, `transformation/CLAUDE.md:22`, the `test_cli_catalog.py` line in `orchestration/CLAUDE.md`, `.claude/skills/blockjuice/references/layers.md:36`, `.claude/skills/blockjuice/workflows/answer.md:28`, `docs/analysis-authoring.md:17,63`. In `transformation/CLAUDE.md`, the hand-run line becomes: set `BJ_ANALYSES=../answers/<slug>/analyses` and pass `--vars '{window: {...}}'`.

- [ ] **Step 12: Commit**

```bash
git add -A transformation answers orchestration .gitignore .github/workflows/ci.yml CLAUDE.md docs .claude/skills/blockjuice
git commit -m "Keep each analysis in its answer's folder"
```

Check `git status` first: it must list no file under `answers/` that you did not move.

---

### Task 2: Give analyses short names

**Files:**
- Rename: `answers/*/analyses/*.sql`
- Modify: every tracked `answers/*/question.yaml` (`analyses`, `expected_columns`, `grain`)
- Modify: `orchestration/pipeline/analysis/specification.py:195`
- Test: `orchestration/tests/test_cli_question.py`, `orchestration/tests/test_cli_answer.py`

**Interfaces:**
- Produces: analysis names without the slug. `<slug with _>` becomes `headline`, and `<slug with _>_<rest>` becomes `<rest>`. Plan 4's `reference.analysis` uses these names.

- [ ] **Step 1: Write the failing test**

In `test_cli_question.py`:

```python
def test_analyses_default_to_the_headline(tmp_path):
    folder = tmp_path / "answers" / "eth-total"
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text("question: How much ETH?\n")
    assert load_question(tmp_path, "eth-total").analyses == ("headline",)
```

- [ ] **Step 2: Run it and see it fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_question.py -q -k headline`
Expected: FAIL, `('eth_total',) != ('headline',)`.

- [ ] **Step 3: Change the default**

`specification.py:195` becomes `tuple(raw.get("analyses", ["headline"]))`. Then run `uv run --project orchestration pytest orchestration/tests/test_cli_answer.py -q`. Where a test fails only because it expected the default name `eth_total` from a question with no `analyses` key, change the expected name to `headline`.

- [ ] **Step 4: Rename the files and rewrite each `question.yaml`**

Run once, outside the repo, with `uv run --project orchestration python <file> .`:

```python
"""Drops the slug from each analysis name, in the file name and in question.yaml."""
import re
import subprocess
import sys
from pathlib import Path

import yaml

root = Path(sys.argv[1]).resolve()
listed = set(subprocess.run(["git", "-C", str(root), "ls-files", "answers"],
                            capture_output=True, text=True, check=True).stdout.split())
for question in sorted((root / "answers").glob("*/question.yaml")):
    prefix = question.parent.name.replace("-", "_")
    text = question.read_text()
    # Longest first, so the bare prefix does not match inside a longer name.
    for name in sorted(yaml.safe_load(text)["analyses"], key=len, reverse=True):
        short = "headline" if name == prefix else name.removeprefix(prefix + "_")
        if short == name:
            print(f"kept: {question.parent.name} {name}")
            continue
        old, new = (question.parent / "analyses" / f"{n}.sql" for n in (name, short))
        if old.relative_to(root).as_posix() in listed:
            subprocess.run(["git", "-C", str(root), "mv", str(old), str(new)], check=True)
        else:
            old.rename(new)
        text = re.sub(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])", short, text)
    question.write_text(text)
```

Expected: no `kept:` line. Every shipped name starts with its slug, and every first analysis is the bare slug.

- [ ] **Step 5: Check the result**

```bash
uv run --project orchestration bj questions --check
uv run --project orchestration pytest orchestration/tests/test_cli_catalog.py orchestration/tests/test_analysis_rules.py -q
git diff --stat -- answers | tail -1
```

Expected: `Validated 13 questions covering 56 SQL analyses.`, all tests pass, and the diff touches only `question.yaml` files and renames. Read the diff of two `question.yaml` files and confirm that only names under `analyses`, `expected_columns` and `grain` changed.

Two answers have outputs that git tracks from before the ignore rule: `tracked-wallets-eth` and `tracked-wallets-sol`, each with `answer.json`, `answer.md` and `results/`. They keep the old names until a rerun. With a warehouse up, run `bj answer` for both and commit what it writes. Without one, leave them and say so in the PR. Then run `uv run --project orchestration pytest orchestration/tests/test_demo.py -q`, since `bj demo` answers `tracked-wallets-eth`: where it expects `results/tracked_wallets_eth.csv`, it now gets `results/headline.csv`.

- [ ] **Step 6: Update the docs**

`.claude/skills/blockjuice/references/question-spec.md:15` (the default is `[headline]`) and its example at line 33, `.claude/skills/blockjuice/workflows/answer.md:28` (the first analysis is `analyses/headline.sql`, the others take short names such as `by_day`), `docs/analysis-authoring.md`, and `.github/factory/build.md` where it names the analysis file.

- [ ] **Step 7: Commit**

```bash
git add -A answers orchestration docs .claude/skills/blockjuice .github/factory/build.md
git commit -m "Name analyses without their slug"
```

---

### Task 3: Write a question's subject once

**Files:**
- Create: `transformation/macros/inputs.sql`, `orchestration/tests/test_question_macros.py`
- Modify: `orchestration/pipeline/analysis/specification.py`, `orchestration/pipeline/analysis/spec.py:11`, `orchestration/pipeline/analysis/runner.py:59-60`
- Modify: the six analyses in `answers/rn1-polymarket-fills-2026-11-08/analyses/`
- Test: `orchestration/tests/test_cli_question.py`, `orchestration/tests/test_cli_answer.py`

**Interfaces:**
- Produces, in `specification.py`: `input_filters(question: Question) -> dict[str, dict[str, list[str]]]`. One entry per item of `question.inputs` that has both `name` and `filter`. Raises `BadInput` naming the input when two such inputs share a name, and naming the value when a value holds `'` or `\`.
- Produces the dbt macro `input_values(input, key)`. With the var it prints `('v1', 'v2')`. Without it, it prints SQL that fails when run with `no values for <input>.<key>: run bj answer`, as `window_bound` in `macros/window.sql` does for a missing window.

- [ ] **Step 1: Write the failing tests**

In `test_cli_question.py` (add `from pipeline.analysis.specification import input_filters`):

```python
QUESTION = """question: Which fills?
inputs:
  - name: fills
    source: polygon.polymarket_ctf_exchange_v2
    filter:
      wallets: ["0x28C6c06298d514Db089934071355E5743bf21d60"]
      coins: ["PURR/USDC", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"]
  - name: metadata
    source: polymarket.markets
"""


def write(tmp_path, text):
    folder = tmp_path / "answers" / "fills"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "question.yaml").write_text(text)
    return load_question(tmp_path, "fills")


def test_input_filters_lowercase_hex_and_keep_other_values(tmp_path):
    assert input_filters(write(tmp_path, QUESTION)) == {"fills": {
        "wallets": ["0x28c6c06298d514db089934071355e5743bf21d60"],
        "coins": ["PURR/USDC", "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],
    }}


def test_input_filters_refuse_a_value_sql_would_misread(tmp_path):
    with pytest.raises(BadInput, match="inputs.fills.filter.wallets.*it's"):
        input_filters(write(tmp_path, QUESTION.replace("0x28C6c06298d514Db089934071355E5743bf21d60", "it's")))


def test_input_filters_refuse_two_inputs_with_one_name(tmp_path):
    with pytest.raises(BadInput, match="two inputs named fills"):
        input_filters(write(tmp_path, QUESTION.replace("name: metadata", "name: fills\n    filter: {wallets: []}")))
```

In `test_cli_answer.py`:

```python
def test_named_input_filters_reach_dbt_compile_as_the_inputs_var(tmp_path, offline, monkeypatch):
    write_question(tmp_path, extra=f'inputs: [{{name: holders, source: ethereum.eth_balances, filter: {{wallets: ["{WALLET}"]}}}}]\n')
    offline(parked=0)
    seen = {}

    def compile_analyses(project, names, blocks, parameters=None):
        seen.update(parameters or {})
        return MANIFEST, ["analysis.t.holders"]

    monkeypatch.setattr(answer, "compile_analyses", compile_analyses)
    assert answer.run(tmp_path, "eth-total") == 0
    assert seen == {"inputs": {"holders": {"wallets": [WALLET.lower()]}}}
```

Create `test_question_macros.py`. It runs real dbt against port 1, where no server listens, as `test_reconciliation.py` does:

```python
"""An answer's analyses compile from its own folder, and read their subject from question.yaml."""
import json
from pathlib import Path

import pytest
from dbt.cli.main import dbtRunner

from pipeline.analysis.specification import input_filters
from pipeline.cli import answer
from pipeline.cli.question import load_question

ROOT = Path(__file__).resolve().parents[2]
PROJECT = ROOT / "transformation"
PROFILE = {"WAREHOUSE_HOST": "localhost", "WAREHOUSE_PORT": "1", "WAREHOUSE_USER": "x",
           "WAREHOUSE_PASSWORD": "x", "WAREHOUSE_DB": "warehouse", "DBT_SCHEMA": "analytics"}
SLUG = "rn1-polymarket-fills-2026-11-08"
WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea"


def compiled(tmp_path, monkeypatch, variables):
    for name, value in PROFILE.items():
        monkeypatch.setenv(name, value)
    with answer.question_paths(PROJECT, ROOT / "answers" / SLUG):
        result = dbtRunner().invoke([
            "compile", "--select", "by_role", "--vars", json.dumps(variables),
            "--project-dir", str(PROJECT), "--profiles-dir", str(PROJECT), "--target-path", str(tmp_path),
            "--log-path", str(tmp_path), "--no-populate-cache", *answer.DBT_FLAGS])
    assert result.success, result.exception
    return result.result.results[0].node.compiled_code


def test_an_analysis_reads_its_subject_from_question_yaml(tmp_path, monkeypatch):
    question = load_question(ROOT, SLUG)
    sql = compiled(tmp_path, monkeypatch, {"window": {"polygon": [1, 2]}, "inputs": input_filters(question)})
    assert f"f.wallet in ('{WALLET}')" in sql


def test_without_bj_answer_the_analysis_compiles_to_sql_that_fails(tmp_path, monkeypatch):
    sql = compiled(tmp_path, monkeypatch, {"window": {"polygon": [1, 2]}})
    assert "no values for wallet_fills.wallets: run bj answer" in sql
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_question_macros.py orchestration/tests/test_cli_question.py -q -k "input or subject or without_bj"`
Expected: FAIL with `cannot import name 'input_filters'`.

- [ ] **Step 3: Add `input_filters` and reserve the var name**

In `spec.py`, `RESERVED = {"window", "coverage", "inputs"}`. In `specification.py`, add `input_filters` below `load_question`. A value is hex when it matches `^0x[0-9a-fA-F]+$`.

- [ ] **Step 4: Pass the var from the runner**

In `runner.run`, build the compile vars as `{**question.parameters}` plus `inputs` when `input_filters(question)` is not empty, and pass them as `parameters` only when the dict is not empty. The dbt test call keeps its own vars: tests do not compile analyses.

- [ ] **Step 5: Write the macro**

Create `transformation/macros/inputs.sql` with `input_values(input, key)`, in the style of `macros/window.sql`, with a comment that says where the var comes from. Double any `'` in a value, though `input_filters` already refuses one.

- [ ] **Step 6: Use it in the RN1 fills analyses**

In each of the six files, replace the wallet comparison. In `by_role.sql`:

```sql
-- before
where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
-- after
where f.wallet in {{ input_values('wallet_fills', 'wallets') }}
```

Then `grep -c 0x2005d16a answers/rn1-polymarket-fills-2026-11-08/analyses/*.sql` must print 0 for every file, comments aside.

- [ ] **Step 7: Run the tests**

Run: `uv run --project orchestration pytest orchestration/tests/test_question_macros.py orchestration/tests/test_cli_question.py orchestration/tests/test_cli_answer.py -q`
Expected: PASS. With a warehouse that holds the eval window, run `bj answer rn1-polymarket-fills-2026-11-08 --eval` before and after this task and compare `answers/rn1-polymarket-fills-2026-11-08/eval/results/` with `diff -r`. Expected: no difference.

- [ ] **Step 8: Document it**

In `.claude/skills/blockjuice/references/question-spec.md`, say that an input's `name` is how an analysis reads its `filter`, with the `input_values` line above as the example. In `.claude/skills/blockjuice/workflows/answer.md`, add the rule: a wallet or token the question is about goes in an input's `filter`, never in the SQL.

- [ ] **Step 9: Commit**

```bash
git add transformation/macros/inputs.sql answers/rn1-polymarket-fills-2026-11-08 orchestration .claude/skills/blockjuice
git commit -m "Read a question's subject from its question.yaml"
```

---

## After the merge

The maintainer's checkout holds untracked answers whose analyses still sit in `transformation/analyses/`. `bj questions --check` names them. Run the two scripts of Tasks 1 and 2 there once: they move untracked files with a plain rename.

Other answers still repeat an address in their SQL: the EF wallet in five files, a token in the `token-*` and `uni-v3` answers. Each can move to `input_values` when someone next edits it.

The `marts` list in `question.yaml` is still written by hand, and it has drifted in two answers: `token-flow-map` leaves out `bridge_transfers`, and the EF answer lists `cow_ethflow_orders`, which no analysis reads. dbt derives the same list for each answer, so `bj questions` could print the derived one. That is a follow-up, not part of this plan.

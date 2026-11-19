# Answer isolation 4: `bj` compares the reference and lists the answers a change touches

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reference lives beside its question and `bj answer --eval` compares it with the result of the real analysis, and `bj questions --affected <ref>` names the answers a change can move.

**Architecture:** The compare is a pure Python function over two lists of CSV rows, with the reasons the dbt macro reports today. `bj answer --eval` runs it after it reads the warehouse and adds the check `reference_match`. The reference seeds, the reference tests, their macro and the three `tag:reference` exclusions leave the dbt project. `bj questions --affected` parses each answer with dbt, collects every file it is built from, and intersects that with the files git says changed.

**Tech Stack:** Python 3 (`decimal`, `csv`), dbt 1.12 manifest, pytest, GitHub Actions.

**Spec:** the contract below. It is step 4 of the answer isolation proposal of 2026-11-17. It needs plan 1: short analysis names, `answers/<slug>/analyses/`, and `question_paths` in `pipeline/cli/answer.py`.

**Baseline:** `main` with plan 1 merged.

## The contract

1. `question.yaml` may hold:

   ```yaml
   reference:
     analysis: by_day                      # one of `analyses`
     key: [day, token, counterparty, metric]
     value: amount
     tolerance: {kind: absolute, value: 0}  # absolute or relative
     oracle: Dune query 9099271, execution 01M71D9W...   # optional: where the rows came from
   ```

   The rows are in `answers/<slug>/reference.csv`, which git tracks. A question with `reference` needs `eval_window`, the blocks the rows cover, and its `reference.csv`.
2. `bj answer <slug> --eval` adds the check `reference_match`. It passes when the rows of `reference.analysis` over the eval window match `reference.csv`. A run without `--eval` adds no such check. `bj check` refuses the name.
3. Five reasons, checked in this order for each key, as `transformation/macros/reference_mismatches.sql` does today (the proposal said six, counting the macro's branches):
   - `duplicate_in_expected`: the key is on more than one row of `reference.csv`.
   - `duplicate_in_actual`: the key is on more than one row of the analysis.
   - `missing_in_actual`: the key is in `reference.csv` only.
   - `missing_in_expected`: the key is in the analysis only.
   - `over_tolerance`: the values differ by more than the tolerance, or exactly one is empty. Two empty values match. A relative tolerance is a share of the expected value, and counts as absolute where that value is 0.
4. Cells compare as text read from CSV, the form `bj answer` writes to `results/`. A value is a decimal number, compared exactly, never as a float. A key cell that is a number compares as a number (`100` equals `100.0`), a key cell that is `0x` hex compares in lowercase, and any other compares as written.
5. The check's detail is `0 mismatches over tolerance`, or `<n> mismatches over tolerance; first: (<key cells>) <reason>, ...` with at most five. The factory's score table matches the first clause, so it must not change.
6. `bj questions --affected <ref>` prints each changed file that an answer is built from, with those answers under it:

   ```
   transformation/models/marts/polymarket/polymarket_markets.sql
     polymarket-overview              no reference
     rn1-polymarket-fills-2026-11-08  has a reference: run bj answer rn1-polymarket-fills-2026-11-08 --eval
   ```

   An answer is built from: its own tracked files, each model, seed and source yml above its analyses, each project macro those call, the package of each source above them, and `dbt_project.yml`. The changed files are those that differ between the working tree and the merge base of `<ref>` and `HEAD`. It needs no warehouse and exits 0.
7. The dbt project loses `seeds/reference/`, `tests/reference/`, `macros/reference_mismatches.sql` and every `tag:reference` exclusion. The two macros that serve one question move into that answer's `macros/`.

Costs, known before building:

- The factory's verdict comes from `bj answer --eval`. A ticket branch cut before this change has no `reference` key, so its verdict is `not_run` until it merges `main`.
- `--affected` sees changed files, not changed loads. Plan 5 covers loads.
- dbt gives a seed over 1 MiB a path, not a hash. No seed is that large today.

## Global Constraints

- Use the terms in `GLOSSARY.md`: answer, analysis, check, reference, record. Never "validation" for a check or "query" for an analysis.
- The repo is public. No hosts, keys, private URLs or client names in code, docs or commits.
- Commits: one imperative sentence in sentence case, no type prefix. Keep the `Co-Authored-By:` trailer. No session link.
- Run pytest as `uv run --project orchestration pytest <file>`, without `.env` exported. After a change to the dbt project, run `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation` first.
- Never change a reference row or widen a tolerance to make a check pass. The rows are the human's.
- The phrase `<n> mismatches over tolerance` is read by `.github/factory/scores.py`. Keep it exact.

## Review Focus

1. A reference CSV saved from a spreadsheet, with a byte order mark and CRLF line ends. It must read as the same rows. Pinned by `test_the_check_reads_reference_csv_and_the_analysis_rows`.
2. Amounts in wei, wider than a float holds. Two that differ in the last digit must not match at tolerance 0. Pinned by `test_wei_amounts_differ_at_the_last_digit`.
3. An address key in checksum case in `reference.csv`, as explorers print it. The warehouse holds lowercase, so every row would be missing on both sides. Pinned by `test_key_cells_compare_as_numbers_and_hex_ignores_case`.
4. An analysis that returns no rows over the eval window. The check must fail with one `missing_in_actual` per reference row, and must not crash. Pinned by `test_the_check_fails_and_shows_the_first_mismatches`.
5. A verdict read from an answer the model wrote before the workflow's own run. The verdict must come from the workflow's run. Pinned by `test_the_verdict_needs_an_answer_from_this_run`.
6. `bj questions --affected` in a shallow CI checkout, where git finds no merge base. It must fall back to the ref itself, and a ref git does not know is bad input. Pinned by `test_changed_files_fall_back_to_the_ref_and_refuse_an_unknown_one`.

## File structure

| File | Change |
|---|---|
| `orchestration/pipeline/analysis/reference.py` | New: `Reference`, `Mismatch`, `parse_reference`, `mismatches`, `reference_check`. |
| `orchestration/pipeline/analysis/specification.py` | `reference` in `FIELDS`, `Question.reference`. |
| `orchestration/pipeline/analysis/runner.py` | Adds the check on an eval run. |
| `orchestration/pipeline/cli/answer.py`, `check.py` | Export `reference_check`. Reserve the name. Drop the exclusion. |
| `orchestration/pipeline/cli/affected.py` | New: `bj questions --affected`. |
| `orchestration/pipeline/analysis/provenance.py` | Seeds count in the file hashes. |
| `answers/<slug>/reference.csv`, `question.yaml` | Six answers gain a reference. |
| `transformation/` | Loses the reference seeds, tests and macro. Two macros move to their answers. |
| `.github/factory/`, `.github/workflows/factory-build.yml` | The prompt and the verdict use `bj answer --eval`. |

---

### Task 1: Compare two sets of rows

**Files:**
- Create: `orchestration/pipeline/analysis/reference.py`
- Test: `orchestration/tests/test_reference.py`

**Interfaces:**
- Produces:

  ```python
  @dataclass(frozen=True)
  class Reference:
      analysis: str
      key: tuple[str, ...]
      value: str
      kind: Literal["absolute", "relative"]
      tolerance: Decimal
      oracle: str = ""

  @dataclass(frozen=True)
  class Mismatch:
      key: tuple[str, ...]      # the key cells as written, from reference.csv when the key is there
      expected: str | None
      actual: str | None
      reason: str

  def mismatches(expected: Sequence[dict[str, str]], actual: Sequence[dict[str, str]],
                 reference: Reference) -> list[Mismatch]: ...
  ```

  A row is a map of column to cell text, and `""` is an empty value. The result is sorted by key. `BadInput` when either side lacks a key or value column (`reference.csv has no column <c>`, `the analysis <name> returns no column <c>`), and when a value is not a number, naming the column and the cell.

- [ ] **Step 1: Write the failing tests**

Create `orchestration/tests/test_reference.py`:

```python
from dataclasses import replace
from decimal import Decimal

import pytest

from pipeline.analysis.reference import Reference, mismatches
from pipeline.cli import BadInput

REFERENCE = Reference("by_day", ("day", "token"), "amount", "absolute", Decimal("0"))


def rows(*cells):
    return [{"day": day, "token": token, "amount": amount} for day, token, amount in cells]


def reasons(expected, actual, reference=REFERENCE):
    return [(m.key, m.reason) for m in mismatches(expected, actual, reference)]


def test_equal_rows_in_any_order_match():
    expected = rows(("2026-11-07", "usdt", "1.50"), ("2026-11-07", "eth", "2"))
    assert reasons(expected, rows(("2026-11-07", "eth", "2.0"), ("2026-11-07", "usdt", "1.5"))) == []


@pytest.mark.parametrize("expected, actual, reason", [
    (rows(("d", "eth", "1"), ("d", "eth", "1")), rows(("d", "eth", "1")), "duplicate_in_expected"),
    (rows(("d", "eth", "1")), rows(("d", "eth", "1"), ("d", "eth", "1")), "duplicate_in_actual"),
    (rows(("d", "eth", "1")), [], "missing_in_actual"),
    ([], rows(("d", "eth", "1")), "missing_in_expected"),
    (rows(("d", "eth", "1")), rows(("d", "eth", "")), "over_tolerance"),
    (rows(("d", "eth", "1")), rows(("d", "eth", "2")), "over_tolerance"),
])
def test_each_kind_of_mismatch_has_its_reason(expected, actual, reason):
    assert reasons(expected, actual) == [(("d", "eth"), reason)]


def test_two_empty_values_match():
    assert reasons(rows(("d", "eth", "")), rows(("d", "eth", ""))) == []


def test_a_relative_tolerance_is_a_share_of_the_expected_value_and_absolute_at_zero():
    relative = replace(REFERENCE, kind="relative", tolerance=Decimal("0.001"))
    assert reasons(rows(("d", "eth", "1000")), rows(("d", "eth", "1001")), relative) == []
    assert reasons(rows(("d", "eth", "1000")), rows(("d", "eth", "1001.1")), relative) == [(("d", "eth"), "over_tolerance")]
    assert reasons(rows(("d", "eth", "0")), rows(("d", "eth", "0.001")), relative) == []
    assert reasons(rows(("d", "eth", "0")), rows(("d", "eth", "0.002")), relative) == [(("d", "eth"), "over_tolerance")]


def test_wei_amounts_differ_at_the_last_digit():
    wei = "131322925334691899062636000000000001"
    assert reasons(rows(("d", "eth", wei)), rows(("d", "eth", wei[:-1] + "2"))) == [(("d", "eth"), "over_tolerance")]


def test_key_cells_compare_as_numbers_and_hex_ignores_case():
    assert reasons(rows(("100", "0xAbC", "1")), rows(("100.0", "0xabc", "1"))) == []
    assert reasons(rows(("d", "ETH", "1")), rows(("d", "eth", "1"))) == [
        (("d", "ETH"), "missing_in_actual"), (("d", "eth"), "missing_in_expected")]


def test_a_value_that_is_not_a_number_is_bad_input():
    with pytest.raises(BadInput, match="amount.*'n/a'"):
        mismatches(rows(("d", "eth", "n/a")), rows(("d", "eth", "1")), REFERENCE)


def test_a_missing_column_is_bad_input():
    with pytest.raises(BadInput, match="reference.csv has no column token"):
        mismatches([{"day": "d", "amount": "1"}], rows(("d", "eth", "1")), REFERENCE)
    with pytest.raises(BadInput, match="the analysis by_day returns no column amount"):
        mismatches(rows(("d", "eth", "1")), [{"day": "d", "token": "eth"}], REFERENCE)
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_reference.py -q`
Expected: FAIL with `No module named 'pipeline.analysis.reference'`.

- [ ] **Step 3: Implement `Reference`, `Mismatch` and `mismatches`**

Parse values with `Decimal`. A key cell is a number when it matches `^-?\d+(\.\d+)?$` and hex when it matches `^0x[0-9a-fA-F]+$`.

- [ ] **Step 4: Run the tests and commit**

Run: `uv run --project orchestration pytest orchestration/tests/test_reference.py -q`
Expected: PASS.

```bash
git add orchestration/pipeline/analysis/reference.py orchestration/tests/test_reference.py
git commit -m "Compare reference rows with an analysis in Python"
```

---

### Task 2: The `reference` key and its check in `bj answer --eval`

**Files:**
- Modify: `orchestration/pipeline/analysis/reference.py`, `orchestration/pipeline/analysis/specification.py:113-125,137-154,195-222`, `orchestration/pipeline/analysis/runner.py:78-86`, `orchestration/pipeline/cli/answer.py`, `orchestration/pipeline/cli/check.py:16`, `.gitignore`
- Test: `orchestration/tests/test_reference.py`, `orchestration/tests/test_cli_question.py`, `orchestration/tests/test_cli_answer.py:628-647`, `orchestration/tests/test_answer_execution.py:143-155`

**Interfaces:**
- Consumes: `Reference`, `mismatches` from Task 1.
- Produces: `parse_reference(raw: dict, analyses: Sequence[str], label: str) -> Reference`. The tolerance is `Decimal(str(value))`.
- Produces: `reference_check(folder: Path, results: Sequence[Result], reference: Reference) -> Check`, named `reference_match`. `folder` is `answers/<slug>`. It reads `folder / "reference.csv"` with `encoding="utf-8-sig"` and `newline=""`, and the result's rows from `result.csv_path` when set, else from `result.rows` through `cell_text`.
- Produces: `Question.reference: Reference | None = None`, after `parameter_scope`. `pipeline.cli.answer.reference_check` is the same function, so the runner reaches it as `api.reference_check`.

- [ ] **Step 1: Write the failing tests**

In `test_cli_question.py` (import `Decimal` and `Reference`):

```python
REFERENCED = """question: How much flowed?
analyses: [headline, by_day]
window: {chain: ethereum, blocks: [100, 200]}
eval_window: {chain: ethereum, blocks: [100, 110]}
reference:
  analysis: by_day
  key: [day, token]
  value: amount
  tolerance: {kind: relative, value: 0.001}
"""


def referenced(tmp_path, text=REFERENCED, rows="day,token,amount\n"):
    folder = tmp_path / "answers" / "flows"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "question.yaml").write_text(text)
    if rows is not None:
        (folder / "reference.csv").write_text(rows)
    return load_question(tmp_path, "flows")


def test_a_reference_names_its_analysis_key_value_and_tolerance(tmp_path):
    assert referenced(tmp_path).reference == Reference("by_day", ("day", "token"), "amount", "relative", Decimal("0.001"))


@pytest.mark.parametrize("old, new, message", [
    ("analysis: by_day", "analysis: by_week", "'reference.analysis' must be one of the analyses"),
    ("key: [day, token]", "key: []", "'reference.key'"),
    ("value: amount", "value: day", "'reference.value'"),
    ("kind: relative", "kind: loose", "'reference.tolerance.kind' must be absolute or relative"),
    ("value: 0.001", "value: -1", "'reference.tolerance.value'"),
    ("eval_window: {chain: ethereum, blocks: [100, 110]}\n", "", "'reference' needs 'eval_window'"),
    ("  value: amount", "  value: amount\n  colour: red", "'reference' has unknown key 'colour'"),
])
def test_a_malformed_reference_is_bad_input(tmp_path, old, new, message):
    with pytest.raises(BadInput, match=message):
        referenced(tmp_path, REFERENCED.replace(old, new))


def test_a_reference_without_its_csv_is_bad_input(tmp_path):
    with pytest.raises(BadInput, match="answers/flows/reference.csv does not exist"):
        referenced(tmp_path, rows=None)
```

In `test_reference.py` (import `date`, `Check`, `Result` from `pipeline.analysis.domain`, and `reference_check`):

```python
def result(columns, rows, csv_path=None):
    return Result("by_day", "select 1", columns, rows, csv_path)


def test_the_check_reads_reference_csv_and_the_analysis_rows(tmp_path):
    (tmp_path / "reference.csv").write_bytes("﻿day,token,amount\r\n2026-11-07,eth,1.5\r\n".encode())
    actual = result(["day", "token", "amount", "txs"], [(date(2026, 11, 7), "eth", Decimal("1.50"), 3)])
    assert reference_check(tmp_path, [actual], REFERENCE) == Check("reference_match", True, "0 mismatches over tolerance")


def test_the_check_fails_and_shows_the_first_mismatches(tmp_path):
    (tmp_path / "reference.csv").write_text("day,token,amount\n2026-11-07,eth,1.5\n2026-11-07,usdt,2\n")
    check = reference_check(tmp_path, [result(["day", "token", "amount"], [])], REFERENCE)
    assert check == Check("reference_match", False, "2 mismatches over tolerance; first: "
                          "(2026-11-07, eth) missing_in_actual, (2026-11-07, usdt) missing_in_actual")


def test_the_check_reads_rows_spooled_to_a_file(tmp_path):
    (tmp_path / "reference.csv").write_text("day,token,amount\n2026-11-07,eth,1.5\n")
    spooled = tmp_path / "by_day.csv"
    spooled.write_text("day,token,amount\n2026-11-07,eth,1.5\n")
    assert reference_check(tmp_path, [result(["day", "token", "amount"], [], spooled)], REFERENCE).passed
```

In `test_cli_answer.py`:

```python
def test_an_eval_run_checks_the_reference_and_a_full_run_does_not(tmp_path, offline, monkeypatch):
    folder = write_question(tmp_path, extra=EVAL_SLICE
        + "reference: {analysis: headline, key: [wallet], value: total, tolerance: {kind: absolute, value: 0}}\n")
    (folder / "reference.csv").write_text("wallet,total\n")
    offline(parked=0)
    seen = []

    def reference_check(folder, results, reference):
        seen.append((folder, reference.analysis))
        return Check("reference_match", True, "0 mismatches over tolerance")

    monkeypatch.setattr(answer, "reference_check", reference_check)
    assert answer.run(tmp_path, "eth-total") == 0
    assert seen == []
    assert answer.run(tmp_path, "eth-total", "eval_window") == 0
    assert seen == [(folder, "headline")]
    checks = json.loads((folder / "eval" / "answer.json").read_text())["checks"]
    assert checks[-1] == {"name": "reference_match", "status": "passed", "detail": "0 mismatches over tolerance"}
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_reference.py orchestration/tests/test_cli_question.py orchestration/tests/test_cli_answer.py -q -k "reference"`
Expected: FAIL with `unknown key 'reference'` and `cannot import name 'reference_check'`.

- [ ] **Step 3: Implement the key**

Add `reference` to `FIELDS` as a map. `_resolve_question` calls `parse_reference` after it has `analysis_names`, and raises `{label}: 'reference' needs 'eval_window', the blocks the reference rows cover` when the question has none. `load_question` raises `answers/{slug}/reference.csv does not exist, and {label} has a 'reference'` when the file is missing.

- [ ] **Step 4: Implement the check and wire it**

In `runner.run`, after the coverage check is appended: when `window_key == "eval_window"` and `question.reference`, append `api.reference_check(repo_root / "answers" / slug, results, question.reference)`. In `check.py`, `ANSWER_CHECKS` gains `"reference_match"`. In `.gitignore`, add `!answers/*/reference.csv` below the other answer lines. In `answer.py` `provenance`, add `":(glob)answers/*/reference.csv"` to the pathspecs that make `git_dirty` true.

- [ ] **Step 5: Run the tests**

Run: `uv run --project orchestration pytest orchestration/tests -q -k "reference or check or answer"`
Expected: the new tests pass. Three older tests record a check named `reference_match` through `bj check`: `test_cli_answer.py:646`, `test_answer_execution.py:143-155` and `test_factory_eval_compatibility.py:116`. In the first two, use the name `cross_check`. Leave the third for Task 5.

- [ ] **Step 6: Document and commit**

Add `reference` and its five keys to `.claude/skills/blockjuice/references/question-spec.md`, with the reasons of contract item 3.

```bash
git add orchestration .gitignore .claude/skills/blockjuice/references/question-spec.md
git commit -m "Check an answer against its reference under --eval"
```

---

### Task 3: Give the six answers their reference

**Files:**
- Create: `answers/<slug>/reference.csv` for six answers, `answers/binance-hack-fbi-eth-2026-11-01/analyses/by_address_metric.sql`
- Modify: the six `question.yaml` files

Each `reference.csv` is a copy of `transformation/seeds/reference/reference_<name>.csv`. The originals stay until Task 4, so both checks can run side by side. Values come from each `tests/reference/<name>_matches_reference.sql` and each entry of `_reference_seeds.yml`:

| Answer | `analysis` | `key` | `value` | `tolerance` |
|---|---|---|---|---|
| `binance-hack-fbi-eth-2026-11-01` | `by_address_metric` (new) | `[address, metric]` | `amount` | absolute, 0 |
| `ef-linked-wallet-eth-outflows-2026-11-10` | `by_outflow` | `[tx_hash, outflow_class]` | `eth` | absolute, 0 |
| `eip8037-state-gas-deployments-2026-11-08` | `by_threshold` | `[threshold_gas]` | `deployments_above` | absolute, 0 |
| `mexc-labelled-flows-2026-11` | `by_day` | `[day, token, counterparty, metric]` | `amount` | absolute, 0 |
| `rn1-polymarket-fills-2026-11-08` | `by_token` | `[token_id, side, role]` | `shares` | relative, 0.000001 |
| `uni-v3-uni-swaps-2026-10-15` | `by_pool` | `[pool, swaps]` | `uni_volume` | relative, 0.001 |

- [ ] **Step 1: Copy the rows and add the keys**

For each row: `cp transformation/seeds/reference/reference_<name>.csv answers/<slug>/reference.csv`, then add the `reference` block to `question.yaml`. Put the seed's `description` from `_reference_seeds.yml`, less its ticket number prefix, in `oracle`.

- [ ] **Step 2: Add what two answers lack**

- `uni-v3-uni-swaps-2026-10-15` has no `eval_window`. Its reference covers the whole window, so add `eval_window: {chain: ethereum, blocks: [26194189, 26201364]}`.
- No Binance hack analysis returns the reference's long form. Add `by_address_metric.sql`, the `actual` CTE of its reference test with the window macros in place of the typed blocks:

  ```sql
  -- The active rows of by_address in long form, one row per address and metric: the shape of reference.csv.
  with flows as (
      {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', window_start('ethereum'), window_end('ethereum'), 26294680) }}
  )

  select flows.address, m.metric, m.amount
  from flows
  cross join lateral (
      values
          ('sent_value_wei', flows.sent_value_wei),
          ('sent_fees_wei', flows.sent_fees_wei),
          ('sent_out_wei', flows.sent_out_wei),
          ('received_wei', flows.received_wei),
          ('balance_wei', flows.balance_wei),
          ('nonce', flows.nonce::numeric),
          ('has_code', case when flows.has_code then 1 when not flows.has_code then 0 end::numeric)
  ) as m (metric, amount)
  where flows.active
  order by flows.address, m.metric
  ```

  In its `question.yaml`, add `by_address_metric` to `analyses`, `[address, metric, amount]` to `expected_columns` and `[address, metric]` to `grain`.

- [ ] **Step 3: Read each reference test against its analysis**

For the other five, open `tests/reference/<name>_matches_reference.sql` beside the named analysis. The test's `actual` must select the same rows as the analysis returns over the eval window. Where the analysis returns rows the test leaves out, stop and report it: the check would then fail with `missing_in_expected`, and the fix is the maintainer's choice between a narrower analysis and a second one.

- [ ] **Step 4: Run the checks**

```bash
uv run --project orchestration bj questions --check
uv run --project orchestration pytest orchestration/tests/test_cli_catalog.py orchestration/tests/test_analysis_rules.py -q
```

Expected: PASS. With a warehouse that holds an answer's eval window, run both checks for it and expect the same verdict:

```bash
set -a && . ./.env && set +a && uv run --project orchestration dbt test --project-dir transformation --profiles-dir transformation --select tag:reference,<name>_matches_reference
uv run --project orchestration bj answer <slug> --eval
```

Say in the commit body which of the six you could run.

- [ ] **Step 5: Commit**

```bash
git add answers
git commit -m "Keep each reference beside its question"
```

---

### Task 4: Take the reference fixtures out of the dbt project

**Files:**
- Delete: `transformation/seeds/reference/` (six CSVs, `_reference_seeds.yml`, `README.md`), `transformation/tests/reference/` (six tests), `transformation/macros/reference_mismatches.sql`
- Move: `transformation/macros/attributed_eth_flows.sql` to `answers/binance-hack-fbi-eth-2026-11-01/macros/`, `transformation/macros/labelled_flows.sql` to `answers/mexc-labelled-flows-2026-11/macros/`
- Modify: `transformation/dbt_project.yml:72-78`, `orchestration/pipeline/assets/dbt.py:11-13,21-23`, `orchestration/pipeline/cli/answer.py:198-221,271-291`, `orchestration/pipeline/demo.py:193-194`
- Test: `orchestration/tests/test_reconciliation.py:53-58`, `orchestration/tests/test_analysis_rules.py:10,24-34,61-62,82-88`, `orchestration/tests/test_cli_answer.py`
- Docs: `GLOSSARY.md:122`, `transformation/CLAUDE.md:23`, `docs/analysis-authoring.md`

- [ ] **Step 1: Change the tests first**

- `test_cli_answer.py`: where a test asserts the arguments `bj answer` gives `dbt test`, drop `"--exclude", "tag:reference"` from the expected list. In `dbt_test_node` cases that tag a test `reference`, expect it among the upstream tests: the tag no longer means anything.
- `test_reconciliation.py`: `compile_tests` drops `"--exclude", "tag:reference"` and the sentence in its docstring.
- `test_analysis_rules.py`: delete `REFERENCE_TEST`, `reference_tests_without_a_question` and its two tests. Add:

  ```python
  def test_every_reference_has_its_rows_and_an_eval_window():
      for slug, question in questions(ROOT).items():
          if "reference" in question:
              assert (ROOT / "answers" / slug / "reference.csv").is_file(), slug
              assert "eval_window" in question, slug
  ```

Run `uv run --project orchestration pytest orchestration/tests/test_cli_answer.py orchestration/tests/test_reconciliation.py -q`. Expected: the changed assertions fail.

- [ ] **Step 2: Delete the fixtures and the exclusions**

Delete the files above with `git rm -r`. Remove lines 72-78 of `dbt_project.yml`. In `assets/dbt.py`, drop `exclude="tag:reference"`, the `"--exclude", "tag:reference"` arguments and the two comments about reference fixtures. In `answer.py`, `run_dbt_tests` drops the exclusion and the last paragraph of its docstring, and `upstream_tests` tests for the `coverage` tag alone. In `demo.py`, drop the exclusion.

- [ ] **Step 3: Move the two question macros**

```bash
grep -rn "attributed_eth_flows\|labelled_flows" transformation/models transformation/tests transformation/macros
```

Expected: only the two macro files themselves. Then `git mv` each into its answer's `macros/`, and in the analyses that name `macros/attributed_eth_flows.sql` or `macros/labelled_flows.sql` in a comment, say the file is in this answer's `macros/`.

- [ ] **Step 4: Run every check**

```bash
set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation
uv run --project orchestration bj questions --check
```

Then, without `.env` exported: `uv run --project orchestration pytest`. Expected: all pass. The compile loop CI runs for each answer (plan 1, Task 1) covers the two moved macros: run it by hand for the two answers.

- [ ] **Step 5: Update the docs and commit**

`GLOSSARY.md:122`: a reference ships as `answers/<slug>/reference.csv` with a `reference` key in `question.yaml`. `transformation/CLAUDE.md:23`: delete the bullet. `docs/analysis-authoring.md`: replace what it says of reference seeds with one paragraph on the key. A warehouse built before this change keeps its `reference_*` seed tables in the dbt schema. They are harmless, and `drop table` removes them.

```bash
git add -A transformation answers orchestration GLOSSARY.md docs/analysis-authoring.md
git commit -m "Take the reference fixtures out of the dbt project"
```

---

### Task 5: The factory proves its build with `bj answer --eval`

Nothing here runs locally end to end: the workflow runs on GitHub. pytest covers `factory.py` and the step scripts `test_factory_eval_compatibility.py` already runs.

**Files:**
- Modify: `.github/factory/build.md:11,33-45`, `.github/factory/factory.py:253-270,466-468,486-488`, `.github/workflows/factory-build.yml:96,150,297-334`
- Test: `orchestration/tests/test_factory.py:248-266`, `orchestration/tests/test_factory_eval_compatibility.py:112-120`
- Docs: `docs/agents/factory.md`

**Interfaces:**
- Changes: `verdict(answer: dict | None, since: str) -> tuple[str, str]`. `since` is an ISO 8601 UTC time. The command is `factory.py verdict <answer.json> <since>`, and prints `status=`, `kind=` and `detail=` as today.

  | Input | Kind | Detail |
  |---|---|---|
  | No file | `not_run` | `bj answer --eval wrote no answer.json` |
  | `answered_at` before `since` | `not_run` | `bj answer --eval did not write a new answer` |
  | No `reference_match` check | `not_run` | `the answer has no reference_match check` |
  | The check passed | `passed` | `0 mismatches over tolerance` |
  | The check failed | `mismatch` | the check's detail up to its first `;` |

- [ ] **Step 1: Rewrite the verdict tests**

In `test_factory.py`, replace the parameters of `test_the_verdict_passes_only_when_the_test_ran_and_returned_no_rows` with answers:

```python
def eval_answer(*checks, answered_at="2026-11-17T10:00:05Z"):
    return {"answered_at": answered_at, "checks": [{"name": n, "status": s, "detail": d} for n, s, d in checks]}


SINCE = "2026-11-17T10:00:00Z"


@pytest.mark.parametrize("answer, output", [
    (eval_answer(("reference_match", "passed", "0 mismatches over tolerance")), "status=passed\nkind=passed\ndetail=0 mismatches over tolerance\n"),
    (eval_answer(("reference_match", "failed", "3 mismatches over tolerance; first: (a) missing_in_actual")), "status=failed\nkind=mismatch\ndetail=3 mismatches over tolerance\n"),
    (eval_answer(("coverage", "passed", "covers")), "status=failed\nkind=not_run\ndetail=the answer has no reference_match check\n"),
])
def test_the_verdict_is_the_reference_check_of_the_eval_answer(tmp_path, capsys, answer, output):
    path = write_json(tmp_path / "answer.json", answer)
    assert factory.main(["verdict", str(path), SINCE]) == 0
    assert capsys.readouterr().out == output


def test_the_verdict_needs_an_answer_from_this_run(tmp_path, capsys):
    stale = eval_answer(("reference_match", "passed", "0 mismatches over tolerance"), answered_at="2026-11-17T09:59:59Z")
    assert factory.main(["verdict", str(write_json(tmp_path / "answer.json", stale)), SINCE]) == 0
    assert capsys.readouterr().out == "status=failed\nkind=not_run\ndetail=bj answer --eval did not write a new answer\n"
    assert factory.main(["verdict", str(tmp_path / "missing.json"), SINCE]) == 0
    assert capsys.readouterr().out == "status=failed\nkind=not_run\ndetail=bj answer --eval wrote no answer.json\n"
```

Run: `uv run --project orchestration pytest orchestration/tests/test_factory.py -q -k verdict`. Expected: FAIL.

- [ ] **Step 2: Change `factory.py`**

`verdict` and `verdict_command` take the answer file and `since`. The parser's help says it reads the eval answer `bj answer --eval` wrote.

- [ ] **Step 3: Change the workflow**

Replace the step `Run the reference test as the verdict` and delete the step `Record the verdict in the evaluation answer`, since `bj answer` now writes the check itself. Remove the `test` output at lines 96 and 150.

```yaml
      # Builds what the reference analysis reads from the committed code, then answers over the eval window.
      # A failed build fails the verdict, since the analysis would read the tables the model's own loop left.
      # The verdict is the reference_match check of an answer this step wrote, never one the model wrote.
      - name: Answer over the eval window as the verdict
        id: verdict
        env:
          FACTORY: ${{ steps.glue.outputs.dir }}
          SLUG: ${{ steps.scope.outputs.slug }}
        run: |
          since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
          analysis=$(uv run --project orchestration python -c "import sys, yaml; print((yaml.safe_load(open(sys.argv[1])).get('reference') or {}).get('analysis', ''))" "answers/$SLUG/question.yaml" || true)
          if [ -z "$analysis" ]; then
            printf 'status=failed\nkind=not_run\ndetail=answers/%s/question.yaml has no reference\n' "$SLUG" | tee -a "$GITHUB_OUTPUT"
            exit 0
          fi
          built=0
          (cd transformation && BJ_ANALYSES="../answers/$SLUG/analyses" BJ_MACROS="../answers/$SLUG/macros" \
            uv run --project ../orchestration dbt build --select "+$analysis" --exclude-resource-type test --exclude-resource-type unit_test) || built=$?
          if [ "$built" -ne 0 ]; then
            printf "status=failed\nkind=not_run\ndetail=dbt build of the analysis's upstream failed\n" | tee -a "$GITHUB_OUTPUT"
            exit 0
          fi
          uv run --project orchestration bj answer "$SLUG" --eval || true
          # bj answer sets the narrative aside, since new results void it. The model wrote this one for the
          # same window, so it goes back for the uploaded answer.
          if [ ! -f "answers/$SLUG/eval/answer.md" ] && [ -f "answers/$SLUG/eval/previous/answer.md" ]; then
            cp "answers/$SLUG/eval/previous/answer.md" "answers/$SLUG/eval/answer.md"
          fi
          uv run --project orchestration python "$FACTORY/factory.py" verdict "answers/$SLUG/eval/answer.json" "$since" | tee -a "$GITHUB_OUTPUT"
```

`dbt build --select "+<analysis>"` selects the models and seeds above an analysis: a scratch `dbt ls` with the same selector listed the 19 above `by_day` of the MEXC answer.

- [ ] **Step 4: Change the compatibility test**

In `test_factory_eval_compatibility.py`, delete the last block, from `verdict = next(step ... "Record the verdict")` to the end: that step is gone. Keep the layout and prompt assertions. Run `uv run --project orchestration pytest orchestration/tests/test_factory.py orchestration/tests/test_factory_eval_compatibility.py orchestration/tests/test_factory_scores.py -q`. Expected: PASS.

- [ ] **Step 5: Change the prompt**

In `.github/factory/build.md`:

- Reading list item 5 goes: the seed README is deleted.
- Do 1: write `answers/<slug>/reference.csv` with the exact contents of `.factory/reference.csv`.
- Do 2: in `question.yaml`, add `reference` with `analysis`, `key` and `value` from `scope.yaml`'s `reference`, `tolerance` from its `tolerance`, and `oracle` from `oracle.kind` and `oracle.ref`. Name the analysis whose rows have the reference's key and value columns, and write that analysis so it returns exactly those rows over a window.
- Do 4: the eval loop is one command, `uv run --project orchestration bj answer <slug> --eval`, and it passes when the `reference_match` line says `passed`.
- Do 5: "When the check fails".
- Comparison: get "got" from `<eval-dir>/results/<analysis>.csv`.
- Stop rule: "when `reference_match` passes".

- [ ] **Step 6: Update the doc and commit**

`docs/agents/factory.md`: the reference lands in the answer folder, and the verdict is the `reference_match` check of `bj answer --eval`. Leave `docs/adr/0001-software-factory.md` as the record it is, and add one line under its status that plan 4 moved the reference.

```bash
git add .github/factory .github/workflows/factory-build.yml orchestration/tests docs/agents/factory.md docs/adr/0001-software-factory.md
git commit -m "Prove a factory build with bj answer --eval"
```

---

### Task 6: `bj questions --affected <ref>`

**Files:**
- Create: `orchestration/pipeline/cli/affected.py`, `orchestration/tests/test_cli_affected.py`
- Modify: `orchestration/pipeline/cli/__init__.py:92-121`, `orchestration/pipeline/cli/catalog.py:37-39`, `.github/workflows/ci.yml`
- Docs: `CLAUDE.md` (Commands), `orchestration/CLAUDE.md`

**Interfaces:**
- Consumes: `answer.dbt`, `answer.question_paths` (plan 1), `read_sources`, `load_question`.
- Produces, in `affected.py`:

  ```python
  def upstream_files(manifest: dict, analysis_ids: Sequence[str], packages: dict[tuple[str, str], str]) -> set[str]: ...
  def answer_files(repo_root: Path, question: Question) -> set[str]: ...
  def changed_files(repo_root: Path, ref: str) -> list[str]: ...
  def run(repo_root: Path, ref: str) -> int: ...
  ```

  Paths are POSIX, from the repo root. An entry that ends in `/` is a folder: a changed file under it counts. `packages` maps a source's `(name, table)` to its package folder name, from `sources.json`. `answer_files` runs `dbt parse` inside `question_paths` into a temporary target, and adds `answers/<slug>/` and `transformation/dbt_project.yml` to `upstream_files`. `changed_files` runs `git merge-base <ref> HEAD` and `git diff --name-only <base>`. When git finds no merge base it diffs against `<ref>`, and when git does not know `<ref>` it raises `BadInput(f"git knows no ref {ref}")`.

- [ ] **Step 1: Write the failing tests**

Create `test_cli_affected.py`:

```python
import subprocess

import pytest

from pipeline import cli
from pipeline.cli import BadInput, affected

MANIFEST = {
    "nodes": {
        "analysis.transformation.headline": {
            "resource_type": "analysis", "name": "headline",
            "original_file_path": "../answers/flows/analyses/headline.sql",
            "depends_on": {"nodes": ["model.transformation.flows"],
                           "macros": ["macro.transformation.in_window", "macro.dbt.run_query"]}},
        "model.transformation.flows": {
            "resource_type": "model", "name": "flows", "original_file_path": "models/marts/transfers/flows.sql",
            "depends_on": {"nodes": ["seed.transformation.labels", "source.transformation.ethereum.erc20_transfers"],
                           "macros": ["macro.transformation.token_transfers"]}},
        "seed.transformation.labels": {
            "resource_type": "seed", "name": "labels", "original_file_path": "seeds/labels.csv",
            "depends_on": {"nodes": [], "macros": []}},
    },
    "sources": {"source.transformation.ethereum.erc20_transfers": {
        "source_name": "ethereum", "name": "erc20_transfers",
        "original_file_path": "models/staging/ethereum/_ethereum__sources.yml"}},
    "macros": {
        "macro.transformation.in_window": {"package_name": "transformation", "original_file_path": "macros/window.sql",
                                           "depends_on": {"macros": ["macro.transformation.window_start"]}},
        "macro.transformation.window_start": {"package_name": "transformation", "original_file_path": "macros/bounds.sql",
                                              "depends_on": {"macros": []}},
        "macro.transformation.token_transfers": {"package_name": "transformation", "original_file_path": "macros/token_transfers.sql",
                                                 "depends_on": {"macros": []}},
        "macro.dbt.run_query": {"package_name": "dbt", "original_file_path": "macros/etc/statement.sql",
                                "depends_on": {"macros": []}},
    },
}


def test_upstream_files_are_every_file_an_answer_is_built_from():
    packages = {("ethereum", "erc20_transfers"): "evm-erc20-transfers"}
    assert affected.upstream_files(MANIFEST, ["analysis.transformation.headline"], packages) == {
        "answers/flows/analyses/headline.sql",
        "transformation/models/marts/transfers/flows.sql",
        "transformation/seeds/labels.csv",
        "transformation/models/staging/ethereum/_ethereum__sources.yml",
        "transformation/macros/window.sql",
        "transformation/macros/bounds.sql",
        "transformation/macros/token_transfers.sql",
        "ingestion/sources/evm-erc20-transfers/",
    }


def question(root, slug, extra=""):
    folder = root / "answers" / slug
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text(f"question: A sample?\n{extra}")


REFERENCE = ("eval_window: {chain: ethereum, blocks: [1, 2]}\n"
             "reference: {analysis: headline, key: [day], value: amount, tolerance: {kind: absolute, value: 0}}\n")


def test_a_changed_file_lists_each_answer_built_from_it(tmp_path, monkeypatch, capsys):
    question(tmp_path, "flows", REFERENCE)
    (tmp_path / "answers" / "flows" / "reference.csv").write_text("day,amount\n")
    question(tmp_path, "prices")
    files = {"flows": {"answers/flows/", "transformation/models/marts/transfers/flows.sql", "ingestion/sources/evm-erc20-transfers/"},
             "prices": {"answers/prices/", "transformation/models/marts/prices/prices.sql"}}
    monkeypatch.setattr(affected, "answer_files", lambda root, q: files[q.slug])
    monkeypatch.setattr(affected, "changed_files", lambda root, ref: [
        "transformation/models/marts/transfers/flows.sql", "ingestion/sources/evm-erc20-transfers/src/source.ts",
        "answers/prices/question.yaml", "docs/architecture.md"])
    assert affected.run(tmp_path, "origin/main") == 0
    assert capsys.readouterr().out == (
        "answers/prices/question.yaml\n"
        "  prices  no reference\n"
        "ingestion/sources/evm-erc20-transfers/src/source.ts\n"
        "  flows   has a reference: run bj answer flows --eval\n"
        "transformation/models/marts/transfers/flows.sql\n"
        "  flows   has a reference: run bj answer flows --eval\n"
    )


def test_no_answer_reads_the_changed_files(tmp_path, monkeypatch, capsys):
    question(tmp_path, "prices")
    monkeypatch.setattr(affected, "answer_files", lambda root, q: {"answers/prices/"})
    monkeypatch.setattr(affected, "changed_files", lambda root, ref: ["docs/architecture.md"])
    assert affected.run(tmp_path, "origin/main") == 0
    assert capsys.readouterr().out == "no answer is built from a changed file\n"


def git(root, *args):
    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                   check=True, capture_output=True)


def test_changed_files_fall_back_to_the_ref_and_refuse_an_unknown_one(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    (tmp_path / "a.sql").write_text("select 1")
    git(tmp_path, "add", "a.sql")
    git(tmp_path, "commit", "-q", "-m", "one")
    git(tmp_path, "checkout", "-q", "-b", "work")
    (tmp_path / "a.sql").write_text("select 2")
    assert affected.changed_files(tmp_path, "main") == ["a.sql"]
    # An orphan branch shares no history with main, as a shallow CI checkout shares none with its base.
    git(tmp_path, "checkout", "-q", "--orphan", "alone")
    git(tmp_path, "commit", "-q", "-m", "two")
    assert affected.changed_files(tmp_path, "main") == ["a.sql"]
    with pytest.raises(BadInput, match="git knows no ref nowhere"):
        affected.changed_files(tmp_path, "nowhere")


def test_cli_passes_the_ref(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "REPO_ROOT", tmp_path)
    seen = []
    monkeypatch.setattr(affected, "run", lambda root, ref: seen.append((root, ref)) or 0)
    assert cli.main(["questions", "--affected", "origin/main"]) == 0
    assert seen == [(tmp_path, "origin/main")]
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_affected.py -q`
Expected: FAIL with `cannot import name 'affected'`.

- [ ] **Step 3: Implement**

`upstream_files` walks `depends_on.nodes` as `ancestors` in `analysis/executor.py` does, and `depends_on.macros` through each macro's own, keeping macros whose `package_name` is the project's. It joins each `original_file_path` to `transformation/` and normalizes it. In `run`, pad each slug to the longest slug among the questions and print two spaces after it. `questions --affected REF` joins the exclusive group with `--json` and `--check` in `cli/__init__.py`, and `_questions` calls `affected.run` when it is set.

- [ ] **Step 4: Run it for real**

```bash
uv run --project orchestration pytest orchestration/tests/test_cli_affected.py orchestration/tests/test_cli_catalog.py -q
uv run --project orchestration bj questions --affected HEAD~1
```

Expected: tests pass. The command prints the answers built from what the last commit changed, in about a minute: one `dbt parse` per answer.

- [ ] **Step 5: Print it on each pull request**

In `.github/workflows/ci.yml`, after pytest in the same job:

```yaml
      - name: List the answers this change can move
        if: github.event_name == 'pull_request'
        run: |
          git fetch --no-tags --depth=1 origin "${{ github.base_ref }}"
          uv run --project orchestration bj questions --affected "origin/${{ github.base_ref }}" | tee -a "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 6: Document and commit**

Add the command to the Commands list in `CLAUDE.md` and to the CLI notes in `orchestration/CLAUDE.md`: run it before changing a mart, a seed or a macro, and rerun `bj answer --eval` for each answer it lists with a reference.

```bash
git add orchestration .github/workflows/ci.yml CLAUDE.md
git commit -m "List the answers a change can move"
```

---

### Task 7: Count seeds in an answer's file hashes

**Files:**
- Modify: `orchestration/pipeline/analysis/provenance.py:16-21`
- Test: `orchestration/tests/test_analysis_runtime.py`

**Interfaces:**
- Produces: `authored_files(nodes: Iterable[dict]) -> dict[str, str]`, each node's `original_file_path` with a hash: dbt's `checksum.checksum` for a seed, the SHA-256 of `raw_code` for any other node that has one. `run_provenance` uses it for `authored_files_sha256`.

- [ ] **Step 1: Write the failing test**

```python
def test_a_seed_edit_changes_the_answers_file_hashes():
    from pipeline.analysis.provenance import authored_files

    model = {"resource_type": "model", "original_file_path": "models/m.sql", "raw_code": "select 1"}

    def seed(checksum):
        return {"resource_type": "seed", "original_file_path": "seeds/labels.csv", "raw_code": "",
                "checksum": {"name": "sha256", "checksum": checksum}}

    first, second = authored_files([model, seed("aaa")]), authored_files([model, seed("bbb")])
    assert (first["seeds/labels.csv"], second["seeds/labels.csv"]) == ("aaa", "bbb")
    assert first["models/m.sql"] == second["models/m.sql"] == hashlib.sha256(b"select 1").hexdigest()
```

- [ ] **Step 2: Run it, implement, run it again**

Run: `uv run --project orchestration pytest orchestration/tests/test_analysis_runtime.py -q -k seed_edit`
Expected: FAIL with `cannot import name 'authored_files'`. A seed's `raw_code` is empty today, so every seed hashes the same and an edit never shows. Implement, then expect PASS.

- [ ] **Step 3: Commit**

```bash
git add orchestration/pipeline/analysis/provenance.py orchestration/tests/test_analysis_runtime.py
git commit -m "Count seeds in an answer's file hashes"
```

# Answer isolation 2: two guards in `bj answer`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An answer's coverage check reads the question's own filter and the warehouse's records, never today's `addresses.json`, and an answer over "loaded rows" says what was loaded and fails on a load someone narrowed.

**Architecture:** Both guards live where every answer passes: the coverage check of `bj answer`. Guard one deletes one line in `Coverage.verified_ranges` and names the missing key in the failure. Guard two replaces the constant "passed" of `window.scope: loaded` with a check over the configurations ingestion recorded in `_coverage`.

**Tech Stack:** Python 3 (`pipeline/cli/coverage.py`, `pipeline/cli/answer.py`, `pipeline/analysis/`), pytest.

**Spec:** the contract below. It is step 2 of the answer isolation proposal of 2026-11-17. It needs nothing from plan 1 and can ship first.

**Baseline:** `main` @ `43275a4`.

## The contract

1. **Guard one.** `Coverage.verified_ranges(wanted)` checks the keys the question names and no others. The line `wanted = {**self.filter, **wanted}` at `coverage.py:78` goes. A recorded configuration that restricts a key the question does not name proves nothing for it, as the lines below already say.
2. When no recorded configuration covers the window and some verified one restricts a key the question left out, the gap reads: `the recorded loads restrict <keys>, which the input's filter does not name; add <keys> to the input's filter in question.yaml`. With `all_wallets: true`, `wallets` is never in that list: the question asked for every wallet.
3. Four shipped questions leave out a key their source's `addresses.json` sets today. Each gets the key, with today's values, so its verdict does not change:

   | Answer | Input source | Keys to add |
   |---|---|---|
   | `binance-hack-fbi-eth-2026-11-01` | `ethereum.wallet_transactions` | `wallets` (the 608 Binance hack addresses) |
   | `ef-linked-wallet-eth-outflows-2026-11-10` | `ethereum.cow_ethflow` | `ethFlow`, `settlement` |
   | `rn1-polymarket-fills-2026-11-08` | `polygon.polymarket_ctf` | `auto_redeemers`, `collateral_adapters`, `conditional_tokens`, `neg_risk_adapter` |
   | `uni-v3-uni-swaps-2026-10-15` | `ethereum.uniswap_v2`, `ethereum.uniswap_v4` | `tokens` |

   The list comes from comparing each tracked `question.yaml` with its source's file on `main` @ `43275a4`.
4. **Guard two.** For a question with `window.scope: loaded`, the `coverage` check lists, per stream input, every recorded configuration: its filter keys with how many values each holds, its start block and the blocks it covered. The check fails for an input when a recorded configuration is narrowed, or when none is recorded. A configuration is narrowed when its filter holds a key that its own `unrestricted` list names, such as `wallets` on the Polymarket exchange source.
5. An input may accept that: `allow_narrowed: true`. The check then passes and still prints what was loaded. `polymarket-overview` asks what the loaded rows show, and its definitions already say a wallet-filtered load is no market-wide sample, so both of its stream inputs get the key.
6. Questions over state, such as `tracked-wallets-eth`, do not change. They read call sources, which have no coverage check.

## Global Constraints

- Use the terms in `GLOSSARY.md`: answer, check, coverage, run, record. Never "validation" for a check.
- The repo is public. No hosts, keys, private URLs or client names in code, docs or commits.
- Commits: one imperative sentence in sentence case, no type prefix. Keep the `Co-Authored-By:` trailer. No session link.
- Run pytest as `uv run --project orchestration pytest <file>`, without `.env` exported.
- `Coverage`'s constructor keeps its field order: tests build it by position.
- Change what the task names. No refactor of `read()`: plan 5 reworks it.

## Review Focus

1. A question with `all_wallets: true` on a wallet-filtered load. It must keep failing, and the message must not tell the author to add `wallets`, which `all_wallets` forbids. Pinned by `test_all_wallets_is_never_told_to_name_wallets`.
2. A warehouse loaded before ingestion recorded coverage, so `evidence` is empty. A loaded-scope answer cannot say what it read, so it fails unless the input allows a narrowed load. Pinned by `test_a_loaded_answer_fails_when_nothing_is_recorded`.
3. One whole-market configuration beside one narrowed one. The raw table then holds a mix, so the loaded-scope check fails. Pinned by `test_a_loaded_answer_fails_when_any_recorded_load_is_narrowed`.
4. A filter key in an old record that the source's contract no longer lists. `verified_ranges` already drops such keys through `supported_filters`, and the new message must drop them too. Pinned by `test_a_key_the_source_no_longer_reads_is_not_asked_for`.
5. A filter value in another letter case than the record. The check lowercases addresses on both sides today. The four edited questions copy values from `addresses.json`, which may hold checksummed addresses. Pinned by the shipped-answer test in Task 1, Step 5.

## File structure

| File | Change |
|---|---|
| `orchestration/pipeline/cli/coverage.py` | Line 78 goes. New `Coverage.unnamed_keys`. `gaps` names the keys. |
| `orchestration/pipeline/analysis/specification.py` | `SourceInput.allow_narrowed`, read from `inputs[].allow_narrowed`. |
| `orchestration/pipeline/cli/answer.py` | New `loaded_check`. |
| `orchestration/pipeline/analysis/runner.py` | Lines 83-84 call `api.loaded_check`. |
| `answers/*/question.yaml` | Five files: four gain filter keys, one gains `allow_narrowed`. |
| `.claude/skills/blockjuice/references/question-spec.md` | The two rules. |

---

### Task 1: An answer's coverage proof reads its own file

**Files:**
- Modify: `orchestration/pipeline/cli/coverage.py:69-121`
- Modify: the four `question.yaml` files in the contract's table
- Test: `orchestration/tests/test_cli_coverage.py`

**Interfaces:**
- Produces: `Coverage.unnamed_keys(self, wanted: dict[str, list[str]], *, all_wallets: bool = False) -> list[str]`. The sorted filter keys that a verified configuration of this dataset restricts and `wanted` does not name. It applies the same `dataset_hash` and `supported_filters` cuts as `verified_ranges`, and leaves `wallets` out when `all_wallets` is true.
- Changes: `Coverage.verified_ranges` and `Coverage.gaps` keep their signatures.

- [ ] **Step 1: Write the failing tests**

In `test_cli_coverage.py`, below `test_restricted_wallet_history_does_not_cover_removing_the_restriction`. `loaded()` and `evidence()` are the file's own helpers:

```python
NARROWED = {"tokens": [USDC.lower()], "wallets": [WALLET.lower()]}


def test_a_question_that_leaves_a_restricted_key_out_fails_and_names_it():
    # addresses.json on disk still lists the wallet. The question's own filter decides.
    read = replace(loaded(), evidence=(evidence(100, 180, NARROWED),), dataset_hash="dataset")
    assert read.gaps((100, 180), {"tokens": [USDC]}) == [
        "the recorded loads restrict wallets, which the input's filter does not name; "
        "add wallets to the input's filter in question.yaml"
    ]
    assert read.gaps((100, 180), {"tokens": [USDC], "wallets": [WALLET]}) == []


def test_a_later_edit_to_addresses_json_does_not_change_an_old_answers_verdict():
    old = replace(loaded(), evidence=(evidence(100, 180, NARROWED),), dataset_hash="dataset")
    # Another question adds a token to the file. The record that proved the old answer is unchanged.
    edited = replace(old, filter={"wallets": [WALLET], "tokens": [USDC, UNI]})
    for wanted in ({"wallets": [WALLET]}, {"wallets": [WALLET], "tokens": [USDC]}):
        assert edited.gaps((100, 180), wanted) == old.gaps((100, 180), wanted)
    assert edited.gaps((100, 180), {"wallets": [WALLET], "tokens": [USDC]}) == []


def test_all_wallets_is_never_told_to_name_wallets():
    read = replace(loaded(), evidence=(evidence(100, 180, NARROWED),), dataset_hash="dataset")
    gaps = read.gaps((100, 180), {"tokens": [USDC]}, all_wallets=True)
    assert gaps and "add wallets" not in gaps[0]
    assert read.unnamed_keys({"tokens": [USDC]}, all_wallets=True) == []


def test_a_key_the_source_no_longer_reads_is_not_asked_for():
    record = evidence(100, 180, {"tokens": [USDC.lower()], "pools": ["0x01"]})
    read = replace(loaded(), evidence=(record,), dataset_hash="dataset", supported_filters=frozenset({"tokens", "wallets"}))
    assert read.unnamed_keys({"tokens": [USDC]}) == []
    assert read.gaps((100, 180), {"tokens": [USDC]}) == []
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_coverage.py -q -k "leaves_a_restricted or later_edit or never_told or no_longer_reads"`
Expected: `test_a_later_edit...` fails on its first comparison: with the merge, the question that names only `wallets` passes before the edit and fails after it, because the merge asks the old record for UNI. The others fail with `AttributeError: 'Coverage' object has no attribute 'unnamed_keys'` or on the message.

- [ ] **Step 3: Delete the merge and name the keys**

Delete `coverage.py:78`. Add `unnamed_keys`. In `gaps`, in the branch for `self.evidence is not None`, when no range covers the window: return the message of contract item 2 if `unnamed_keys(wanted, all_wallets=all_wallets)` is not empty, else the message it returns today.

- [ ] **Step 4: Run the coverage tests**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_coverage.py orchestration/tests/test_cli_answer.py -q`
Expected: the four new tests pass. A test that relied on the merge now fails: it passes `{}` or a partial filter to `gaps` on a `Coverage` whose records restrict more. For each, give `gaps` the keys the record restricts, since that is what a question must now do. Do not restore the merge.

- [ ] **Step 5: Pin the shipped answers**

Add to `test_cli_coverage.py`. It needs no warehouse: it compares each shipped question with the file its source loads from today.

```python
def test_every_shipped_stream_input_names_each_key_its_source_restricts():
    from pipeline.cli.question import load_question

    entries = {f"{e.name}.{e.table}": e for e in read_sources((REPO_ROOT / SOURCES_FILE).read_text())}
    streams = set(stream_sources(REPO_ROOT))
    problems = []
    for path in sorted((REPO_ROOT / "answers").glob("*/question.yaml")):
        question = load_question(REPO_ROOT, path.parent.name)
        if question.window.get("scope") == "loaded":
            continue
        for item in question.sources:
            if item.source not in streams:
                continue
            entry = entries[item.source]
            contract = entry.coverage or {}
            supported = frozenset(contract["filters"]) if "filters" in contract else None
            loaded_keys = coverage.address_filter(REPO_ROOT, entry.folder(REPO_ROOT), supported=supported)
            left_out = sorted(set(loaded_keys) - set(item.filter) - ({"wallets"} if item.all_wallets else set()))
            if left_out:
                problems.append(f"{question.slug}: {item.source} leaves out {', '.join(left_out)}")
    assert problems == []
```

Run it. Expected: FAIL, listing the five inputs of the contract's table.

- [ ] **Step 6: Add the keys to the four questions**

For each row of the table, add the keys under that input's `filter`, with the values of the source's `addresses.json`, lowercased. Print them ready to paste:

```bash
uv run --project orchestration python -c "
import json, sys
for key, values in json.load(open(sys.argv[1])).items():
    values = [values] if isinstance(values, str) else values
    print(f'      {key}:'); [print(f'        - \"{v.lower()}\"') for v in values]
" ingestion/sources/evm-wallet-transactions/chains/ethereum/addresses.json
```

Files: `evm-wallet-transactions/chains/ethereum/addresses.json`, `evm-cow-ethflow/chains/ethereum/addresses.json`, `polygon-polymarket-ctf/addresses.json`, `evm-uniswap-v2/…` and `evm-uniswap-v4/…` (find each with `bj coverage`'s `start_block_file`, or `ls ingestion/sources/<package>`). For the Binance hack question, name only the 608 addresses it is about: the `address` column of `transformation/seeds/attributed_addresses.csv`, whose 608 rows all carry `binance-hack-2026-10-29`. Leave out the 24 wallets other questions added to the source's file since. A YAML anchor (`wallets: &hack`) keeps the list in one place if a second input needs it.

- [ ] **Step 7: Run every check**

```bash
uv run --project orchestration pytest orchestration/tests/test_cli_coverage.py orchestration/tests/test_cli_catalog.py -q
uv run --project orchestration bj questions --check
```

Expected: all pass. With a warehouse up, run `bj answer` for one edited question, such as `uni-v3-uni-swaps-2026-10-15`, and expect the coverage verdict it gave before.

- [ ] **Step 8: Document and commit**

In `.claude/skills/blockjuice/references/question-spec.md`, under `inputs[].filter`: name every key the load restricts, since the check reads this filter and the warehouse's records and never the source's file.

```bash
git add orchestration answers .claude/skills/blockjuice/references/question-spec.md
git commit -m "Prove an answer's coverage from its own filter"
```

---

### Task 2: A "loaded" answer says what was loaded

**Files:**
- Modify: `orchestration/pipeline/analysis/specification.py:27-39,170-187`
- Modify: `orchestration/pipeline/cli/answer.py` (new function below `coverage_check`)
- Modify: `orchestration/pipeline/analysis/runner.py:83-84`
- Modify: `answers/polymarket-overview/question.yaml`
- Test: `orchestration/tests/test_cli_answer.py`, `orchestration/tests/test_cli_question.py`

**Interfaces:**
- Produces: `SourceInput.allow_narrowed: bool = False`, the last field, read from `inputs[<n>].allow_narrowed`. A value that is not a boolean is `BadInput`, as for `all_wallets`.
- Produces, in `cli/answer.py`: `loaded_check(inputs: Iterable[SourceInput], coverages: dict[str, Coverage]) -> Check`, named `coverage`.

- [ ] **Step 1: Write the failing tests**

In `test_cli_answer.py`:

```python
def recorded(first, last, filters, unrestricted=("wallets",)):
    return {"first": first, "last": last, "verified": True, "config": {
        "version": 1, "source": "ethereum", "table": "erc20_transfers", "startBlock": first,
        "datasetHash": "dataset", "filter": filters, "unrestricted": list(unrestricted), "settings": {}}}


WHOLE = recorded(100, 180, {"tokens": [USDC.lower()]})
NARROWED = recorded(100, 180, {"tokens": [USDC.lower()], "wallets": [WALLET.lower()]})


def loaded_scope(evidence, **input_fields):
    inputs = [SourceInput(TRANSFERS, {}, **input_fields)]
    return answer.loaded_check(inputs, {TRANSFERS: replace(LOADED, evidence=evidence)})


def test_a_loaded_answer_passes_and_says_what_was_loaded():
    check = loaded_scope((WHOLE,))
    assert (check.name, check.passed) == ("coverage", True)
    assert check.detail == (
        "ethereum.erc20_transfers: loaded rows only; 1 recorded load: tokens (1) from block 100, blocks 100-180"
    )


def test_a_loaded_answer_fails_when_any_recorded_load_is_narrowed():
    check = loaded_scope((WHOLE, NARROWED))
    assert not check.passed
    assert "tokens (1), wallets (1) from block 100, blocks 100-180" in check.detail
    assert check.detail.endswith(
        "narrowed by wallets; load every value, or set allow_narrowed: true on the input"
    )


def test_an_input_may_accept_a_narrowed_load():
    check = loaded_scope((NARROWED,), allow_narrowed=True)
    assert check.passed
    assert check.detail.endswith("narrowed by wallets, which the input allows")


def test_a_loaded_answer_fails_when_nothing_is_recorded():
    check = loaded_scope(())
    assert not check.passed
    assert check.detail == (
        "ethereum.erc20_transfers: loaded rows only; no recorded load, so its filter is unknown; "
        "run the source once, or set allow_narrowed: true on the input"
    )
    assert loaded_scope((), allow_narrowed=True).passed
```

In `test_cli_question.py`:

```python
def test_allow_narrowed_must_be_boolean(tmp_path):
    folder = tmp_path / "answers" / "fills"
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text(
        "question: Which fills?\ninputs: [{source: polygon.polymarket_ctf, allow_narrowed: sometimes}]\n")
    with pytest.raises(BadInput, match=r"inputs\[0\].allow_narrowed' must be boolean"):
        load_question(tmp_path, "fills")
```

- [ ] **Step 2: Run them and see them fail**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_answer.py orchestration/tests/test_cli_question.py -q -k "loaded_answer or narrowed"`
Expected: FAIL with `unexpected keyword argument 'allow_narrowed'` and `no attribute 'loaded_check'`.

- [ ] **Step 3: Add the field and the check**

`SourceInput` gains `allow_narrowed`, parsed beside `all_wallets` in `_resolve_question`. `loaded_check` describes each record of `coverage.evidence` as `<key> (<count>), ... from block <startBlock>, blocks <first>-<last>`, with keys in sorted order. One input's detail is `<source>: loaded rows only; <n> recorded load: <records joined by "; ">` (`loads` when n is not 1), and then the ending the tests fix: nothing, `; narrowed by <keys>; load every value, or set allow_narrowed: true on the input`, or `; narrowed by <keys>, which the input allows`. An input's narrowing keys are the keys of any record's `config["filter"]` that are in that record's `config["unrestricted"]`, sorted. Details of several inputs join with `; `, as in `coverage_check`.

- [ ] **Step 4: Call it from the runner**

`runner.py:83-84` becomes `checks.append(api.loaded_check(streams, coverages))`. The `else` branch is unchanged.

- [ ] **Step 5: Run the tests**

Run: `uv run --project orchestration pytest orchestration/tests/test_cli_answer.py orchestration/tests/test_cli_question.py orchestration/tests/test_analysis_runtime.py -q`
Expected: PASS. A test that asserts the old detail, `loaded rows only; historical completeness is not asserted`, now asserts the new one.

- [ ] **Step 6: Let the overview accept its load**

In `answers/polymarket-overview/question.yaml`, add `allow_narrowed: true` to the `market_fills` and `conditions_and_positions` inputs. With a warehouse up, run `bj answer polymarket-overview`. Expected: the `coverage` line prints each recorded load with its filter and blocks, and the check passes.

- [ ] **Step 7: Document and commit**

In `.claude/skills/blockjuice/references/question-spec.md`, add `inputs[].allow_narrowed` with one sentence on when to set it: the question is about whatever is loaded, and says so in its definitions.

```bash
git add orchestration answers/polymarket-overview/question.yaml .claude/skills/blockjuice/references/question-spec.md
git commit -m "Say what a loaded answer was loaded from"
```

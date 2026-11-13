import csv
import json
from dataclasses import replace
from pathlib import Path
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from pipeline.cli import REQUIRED_ENV, BadInput, answer, check
from pipeline.cli.answer import (
    Check,
    Input,
    LastRun,
    Result,
    answer_document,
    cell_text,
    dbt_tests_check,
    dead_letters_check,
    freshness_check,
    headline,
    jsonable,
    upstream_inputs,
    write_answer,
)
from pipeline.cli.coverage import Coverage
from pipeline.cli.question import SourceInput, load_question

WEI = Decimal(131322925334691899062636)
ETH = Input("ethereum", "eth_balances", "raw.ethereum_eth_balances")
SOL = Input("solana", "sol_balances", "raw.solana_sol_balances")
TRANSFERS = "ethereum.erc20_transfers"
WALLET = "0x28C6c06298d514Db089934071355E5743bf21d60"
USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
LOADED = Coverage("ethereum", "erc20_transfers", "raw.ethereum_erc20_transfers", 100, ".env", 180, {"wallets": [WALLET], "tokens": [USDC]})


def source(name, table):
    return {"source_name": name, "name": table, "schema": "raw", "identifier": f"{name}_{table}"}


MANIFEST = {
    "sources": {
        "source.t.ethereum.eth_balances": source("ethereum", "eth_balances"),
        "source.t.solana.sol_balances": source("solana", "sol_balances"),
        "source.t.bitcoin.btc_balances": source("bitcoin", "btc_balances"),
        "source.t.ethereum.erc20_transfers": source("ethereum", "erc20_transfers"),
    },
    "nodes": {
        "analysis.t.holders": {"depends_on": {"nodes": ["model.t.latest", "model.t.stg_eth"]}},
        "model.t.latest": {"depends_on": {"nodes": ["model.t.int_eth", "model.t.int_sol", "seed.t.labels"]}},
        "model.t.int_eth": {"depends_on": {"nodes": ["model.t.stg_eth"]}},
        "model.t.int_sol": {"depends_on": {"nodes": ["model.t.stg_sol"]}},
        "model.t.stg_eth": {"depends_on": {"nodes": ["source.t.ethereum.eth_balances"]}},
        "model.t.stg_sol": {"depends_on": {"nodes": ["source.t.solana.sol_balances"]}},
        "seed.t.labels": {"depends_on": {"nodes": []}},
        "model.t.stg_btc": {"depends_on": {"nodes": ["source.t.bitcoin.btc_balances"]}},
        "analysis.t.flows": {"depends_on": {"nodes": ["source.t.ethereum.erc20_transfers"]}},
    },
}


def test_inputs_are_the_sources_reached_through_every_path_once():
    assert upstream_inputs(MANIFEST, ["analysis.t.holders"]) == [ETH, SOL]


def test_inputs_of_several_analyses_are_merged_and_sorted():
    assert upstream_inputs(MANIFEST, ["model.t.stg_btc", "analysis.t.holders"]) == [
        Input("bitcoin", "btc_balances", "raw.bitcoin_btc_balances"),
        ETH,
        SOL,
    ]


def test_json_keeps_big_numbers_exact_as_strings():
    assert jsonable(2**53 - 1) == 2**53 - 1
    assert jsonable(2**53) == "9007199254740992"
    assert jsonable(WEI) == "131322925334691899062636"
    assert jsonable(Decimal("0.0000000000")) == "0.0000000000"
    assert jsonable(True) is True


def test_json_datetimes_are_utc():
    plus_two = timezone(timedelta(hours=2))
    assert jsonable(datetime(2026, 11, 4, 21, 0, tzinfo=plus_two)) == "2026-11-04T19:00:00Z"
    assert jsonable(datetime(2026, 11, 4, 19, 0)) == "2026-11-04T19:00:00Z"


def test_csv_cells_are_exact_text():
    assert [cell_text(v) for v in (None, WEI, 12, 0.1, True, {"a": 2**60}, "x")] == [
        "",
        "131322925334691899062636",
        "12",
        "0.1",
        "true",
        '{"a": "1152921504606846976"}',
        "x",
    ]


def test_headline_is_the_first_analysis_single_cell():
    one = Result("count", "", ["n"], [(WEI,)])
    two_rows = Result("rows", "", ["n"], [(1,), (2,)])
    two_columns = Result("cols", "", ["a", "b"], [(1, 2)])
    assert headline([one, two_rows]) == WEI
    assert headline([two_rows, one]) is None
    assert headline([two_columns]) is None


def test_dbt_tests_pass_unless_a_test_fails_or_errors():
    assert dbt_tests_check([("a", "pass"), ("c", "warn"), ("b", "warn")]) == Check(
        "dbt_tests", True, "1 passed, 2 warned: b, c"
    )
    assert dbt_tests_check([("z", "fail"), ("a", "pass"), ("m", "error")]) == Check(
        "dbt_tests", False, "1 passed, 2 failed: m, z"
    )


def test_dead_letters_fail_when_any_input_has_one():
    assert dead_letters_check({ETH: (0, 0), SOL: (0, 0)}).passed
    parked = dead_letters_check({ETH: (0, 0), SOL: (0, 2)})
    assert not parked.passed
    assert parked.detail == "ethereum.eth_balances 0 pending, 0 parked; solana.sol_balances 0 pending, 2 parked"
    assert dead_letters_check({}) == Check("dead_letters", True, "no inputs")


def test_freshness_fails_when_an_input_never_succeeded():
    finished = datetime(2026, 11, 4, 6, 0, 12, tzinfo=timezone.utc)
    check = freshness_check({ETH: LastRun(finished, 3, "run-1"), SOL: None})
    assert check == Check(
        "freshness",
        False,
        "ethereum.eth_balances finished 2026-11-04T06:00:12Z; solana.sol_balances has no successful run",
    )


def write_question(root, slug="eth-total", extra=""):
    folder = root / "answers" / slug
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "question.yaml").write_text(
        f"question: How much ETH do the wallets hold?\nwindow: {{at: 2026-11-01}}\n{extra}"
    )
    return folder


def document(tmp_path, answered_at):
    question = load_question(tmp_path, "eth-total")
    finished = datetime(2026, 11, 4, 6, 0, tzinfo=timezone.utc)
    return answer_document(
        question,
        answered_at,
        [Result("eth_total", "select 1", ["total"], [(WEI,)])],
        {ETH: (0, 0), SOL: (1, 0)},
        {ETH: LastRun(finished, 12, "run-1"), SOL: None},
        [Check("dbt_tests", True, "3 passed")],
        {"git_sha": "abc", "git_dirty": False, "dbt_version": "1.12.6"},
    )


def test_answer_document_has_the_documented_shape(tmp_path):
    write_question(tmp_path)
    doc = document(tmp_path, datetime(2026, 11, 4, 19, 0, 0, 123456, tzinfo=timezone.utc))
    assert list(doc) == [
        "question", "slug", "answered_at", "value", "definitions", "alternatives", "window", "eval",
        "results", "inputs", "checks", "provenance",
    ]
    assert doc["answered_at"] == "2026-11-04T19:00:00Z"
    assert doc["value"] == "131322925334691899062636"
    assert doc["window"] == {"at": "2026-11-01"}
    assert doc["eval"] is False
    assert doc["results"] == [
        {"analysis": "eth_total", "path": "results/eth_total.csv", "columns": ["total"], "rows": 1, "sql": "select 1"}
    ]
    assert doc["inputs"] == [
        {
            "source": "ethereum.eth_balances",
            "raw_table": "raw.ethereum_eth_balances",
            "last_run": {"finished_at": "2026-11-04T06:00:00Z", "records_written": 12, "dagster_run_id": "run-1"},
            "dead_letters": {"pending": 0, "parked": 0},
        },
        {
            "source": "solana.sol_balances",
            "raw_table": "raw.solana_sol_balances",
            "last_run": None,
            "dead_letters": {"pending": 1, "parked": 0},
        },
    ]
    assert doc["checks"] == [{"name": "dbt_tests", "status": "passed", "detail": "3 passed"}]


def test_rerun_replaces_results_and_changes_only_answered_at(tmp_path):
    folder = write_question(tmp_path)
    (folder / "results").mkdir()
    (folder / "results" / "stale.csv").write_text("old\n")
    result = Result("eth_total", "select 1", ["total", "note"], [(WEI, None)])

    write_answer(folder, [result], document(tmp_path, datetime(2026, 11, 4, 19, 0, tzinfo=timezone.utc)))
    first = (folder / "answer.json").read_text()
    write_answer(folder, [result], document(tmp_path, datetime(2026, 11, 5, 8, 0, tzinfo=timezone.utc)))
    second = (folder / "answer.json").read_text()

    assert sorted(p.name for p in (folder / "results").iterdir()) == ["eth_total.csv"]
    with open(folder / "results" / "eth_total.csv", newline="") as file:
        assert list(csv.reader(file)) == [["total", "note"], ["131322925334691899062636", ""]]
    changed = [(a, b) for a, b in zip(first.splitlines(), second.splitlines()) if a != b]
    assert changed == [('  "answered_at": "2026-11-04T19:00:00Z",', '  "answered_at": "2026-11-05T08:00:00Z",')]


def test_an_analysis_dbt_does_not_know_is_bad_input(tmp_path, monkeypatch):
    def compile(project, *args):
        target = Path(args[args.index("--target-path") + 1])
        (target / "manifest.json").write_text(json.dumps({"nodes": {}, "sources": {}}))
        return SimpleNamespace(success=True)

    monkeypatch.setattr(answer, "dbt", compile)
    with pytest.raises(BadInput, match="write transformation/analyses/eth_total.sql"):
        answer.compile_analyses(tmp_path, ["eth_total"], {})


@pytest.fixture
def offline(monkeypatch):
    """answer.run with dbt and the warehouse replaced by fixed results."""
    for name in REQUIRED_ENV:
        monkeypatch.setenv(name, "x")
    monkeypatch.setattr(answer, "compile_analyses", lambda project, names, blocks: (MANIFEST, ["analysis.t.holders"]))
    dbt_coverages = []

    def run_dbt_tests(project, names, coverages, upstream=()):
        dbt_coverages.append(coverages)
        return Check("dbt_tests", True, "3 passed")

    monkeypatch.setattr(answer, "run_dbt_tests", run_dbt_tests)
    monkeypatch.setattr(answer, "dagster_history", lambda manifest, tests: ({}, {}))
    monkeypatch.setattr(answer, "provenance", lambda root: {"git_sha": "abc", "git_dirty": False, "dbt_version": "x"})
    monkeypatch.setattr(answer.coverage, "sources", lambda root: [TRANSFERS, "ethereum.eth_balances"])
    monkeypatch.setattr(answer.coverage, "stream_sources", lambda root: [TRANSFERS])
    monkeypatch.setattr(answer.coverage, "read", lambda root, name: {TRANSFERS: LOADED}[name])
    finished = datetime(2026, 11, 4, 6, 0, tzinfo=timezone.utc)

    def read_warehouse(manifest, analysis_ids, inputs, parked=0):
        return (
            [Result("eth_total", "select 1", ["total"], [(WEI,)])],
            {i: (0, parked) for i in inputs},
            {i: LastRun(finished, 1, None) for i in inputs},
        )

    def use(parked):
        monkeypatch.setattr(answer, "read_warehouse", lambda *args: read_warehouse(*args, parked=parked))

    use.dbt_coverages = dbt_coverages
    return use


def test_a_failed_check_still_writes_answer_json_and_exits_1(tmp_path, offline, capsys):
    folder = write_question(tmp_path)
    offline(parked=1)
    assert answer.run(tmp_path, "eth-total") == 1
    doc = json.loads((folder / "answer.json").read_text())
    assert [(c["name"], c["status"]) for c in doc["checks"]] == [
        ("dbt_tests", "passed"),
        ("dead_letters", "failed"),
        ("freshness", "passed"),
    ]
    out = capsys.readouterr().out
    assert "value: 131322925334691899062636" in out
    assert "dead_letters: FAILED" in out


def test_all_checks_passing_exits_0(tmp_path, offline):
    write_question(tmp_path)
    offline(parked=0)
    assert answer.run(tmp_path, "eth-total") == 0


def test_missing_settings_are_bad_input_before_any_write(tmp_path, offline, monkeypatch):
    folder = write_question(tmp_path)
    offline(parked=0)
    monkeypatch.delenv("RAW_SCHEMA")
    with pytest.raises(BadInput, match="set RAW_SCHEMA in .env"):
        answer.run(tmp_path, "eth-total")
    assert sorted(p.name for p in folder.iterdir()) == ["question.yaml"]


@pytest.fixture
def history(tmp_path, offline, monkeypatch):
    """Answers a question whose analysis reads the stream source, which loaded blocks 100 to 180."""
    offline(parked=0)
    compiled = []

    def compile_analyses(project, names, blocks):
        compiled.append(blocks)
        return MANIFEST, ["analysis.t.flows"]

    monkeypatch.setattr(answer, "compile_analyses", compile_analyses)

    def ask(window, inputs, extra="", window_key="window"):
        folder = tmp_path / "answers" / "usdc-flows"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "question.yaml").write_text(f"question: How much USDC moved?\nwindow: {window}\ninputs: {inputs}\n{extra}")
        code = answer.run(tmp_path, "usdc-flows", window_key)
        if window_key == "eval_window":
            folder = folder / "eval"
        checks = json.loads((folder / "answer.json").read_text())["checks"]
        return code, {c["name"]: (c["status"], c["detail"]) for c in checks}

    ask.compiled = compiled
    return ask


USDC_FLOWS = f'[{{source: {TRANSFERS}, filter: {{tokens: ["{USDC.lower()}"]}}}}]'


def test_coverage_passes_when_the_source_loaded_the_blocks_and_the_filter(history):
    code, checks = history("{chain: ethereum, blocks: [100, 180]}", USDC_FLOWS)
    assert code == 0
    assert checks["coverage"] == ("passed", "ethereum.erc20_transfers (loaded 100-180) covers blocks 100-180 and the filter")


def test_bj_check_refuses_the_name_of_every_check_bj_answer_runs(history):
    _, checks = history("{chain: ethereum, blocks: [100, 180]}", USDC_FLOWS)
    assert sorted(checks) == sorted(check.ANSWER_CHECKS)


def test_a_new_answer_drops_the_checks_the_agent_added(tmp_path, history):
    history("{chain: ethereum, blocks: [100, 180]}", USDC_FLOWS)
    assert check.run(tmp_path, "usdc-flows", "cross_check", "passed", "Portal agrees") == 0
    _, checks = history("{chain: ethereum, blocks: [100, 180]}", USDC_FLOWS)
    assert "cross_check" not in checks


def test_dbt_tests_get_what_the_stream_inputs_loaded_and_state_answers_get_nothing(tmp_path, history, offline, monkeypatch):
    history("{chain: ethereum, blocks: [100, 180]}", USDC_FLOWS)
    write_question(tmp_path)
    monkeypatch.setattr(answer, "compile_analyses", lambda project, names, blocks: (MANIFEST, ["analysis.t.holders"]))
    answer.run(tmp_path, "eth-total")
    assert offline.dbt_coverages == [{TRANSFERS: LOADED}, {}]


def test_dbt_test_runs_only_the_tests_on_the_marts_the_analyses_read(monkeypatch):
    """`1+` takes each analysis and the models it selects from, the marts; their tests come with them.
    Tests further upstream ran when the pipeline's dbt build made those marts, except those tagged
    `coverage`, which compare nothing without bj answer's var('coverage')."""
    calls = []

    def dbt(project, *args):
        calls.append(args)
        return SimpleNamespace(exception=None, result=SimpleNamespace(results=[]))

    monkeypatch.setattr(answer, "dbt", dbt)
    answer.run_dbt_tests(Path("transformation"), ["eth_total", "eth_total_by_wallet"], {})
    assert calls == [
        (
            "test", "--select",
            "1+eth_total", "+eth_total,tag:coverage", "1+eth_total_by_wallet", "+eth_total_by_wallet,tag:coverage",
            "--exclude", "tag:reference",
        )
    ]


def test_upstream_tests_are_named_by_the_tests_bj_answer_must_rerun(monkeypatch):
    calls = []

    def dbt(project, *args):
        calls.append(args)
        return SimpleNamespace(exception=None, result=SimpleNamespace(results=[]))

    monkeypatch.setattr(answer, "dbt", dbt)
    answer.run_dbt_tests(Path("transformation"), ["eth_total"], {}, ["unique_int_eth_id", "not_null_stg_eth_id"])
    assert calls == [
        (
            "test", "--select", "1+eth_total", "+eth_total,tag:coverage", "unique_int_eth_id", "not_null_stg_eth_id",
            "--exclude", "tag:reference",
        )
    ]


def dbt_test_node(parents, tags=(), kind="test"):
    return {"resource_type": kind, "depends_on": {"nodes": list(parents)}, "tags": list(tags)}


GRAPH = {
    "nodes": {
        "analysis.t.overview": {"resource_type": "analysis", "depends_on": {"nodes": ["model.t.trades", "model.t.wallets"]}},
        "model.t.trades": {"resource_type": "model", "depends_on": {"nodes": ["model.t.int_fills", "model.t.markets"]}},
        "model.t.wallets": {"resource_type": "model", "depends_on": {"nodes": ["model.t.int_ledger"]}},
        "model.t.markets": {"resource_type": "model", "depends_on": {"nodes": ["model.t.stg_markets"]}},
        "model.t.int_fills": {"resource_type": "model", "depends_on": {"nodes": ["model.t.stg_fills"]}},
        "model.t.int_ledger": {"resource_type": "model", "depends_on": {"nodes": ["model.t.stg_fills"]}},
        "model.t.stg_fills": {"resource_type": "model", "depends_on": {"nodes": ["source.t.polygon.fills"]}},
        "model.t.stg_markets": {"resource_type": "model", "depends_on": {"nodes": []}},
        "model.t.elsewhere": {"resource_type": "model", "depends_on": {"nodes": []}},
        "test.t.unique_trades_id": dbt_test_node(["model.t.trades"]),
        "test.t.trades_match_wallets": dbt_test_node(["model.t.trades", "model.t.int_ledger"]),
        "test.t.unique_int_fills_id": dbt_test_node(["model.t.int_fills"]),
        "test.t.unique_stg_fills_id": dbt_test_node(["model.t.stg_fills"]),
        "test.t.not_null_stg_markets_id": dbt_test_node(["model.t.stg_markets"]),
        "test.t.not_null_fills_source": dbt_test_node(["source.t.polygon.fills"]),
        "test.t.reconciles": dbt_test_node(["model.t.int_ledger"], tags=["coverage"]),
        "test.t.ticket": dbt_test_node(["model.t.int_ledger"], tags=["reference"]),
        "unit_test.t.int_fills.math": dbt_test_node(["model.t.int_fills"], kind="unit_test"),
        "test.t.not_null_elsewhere_id": dbt_test_node(["model.t.elsewhere"]),
    },
    "sources": {"source.t.polygon.fills": source("polygon", "fills")},
}


def test_upstream_tests_are_the_data_tests_above_the_marts_with_the_marts_they_feed():
    """The marts' own tests run through 1+, coverage tests through their tag, unit tests check code that the
    marts' build already ran, and reference tests stay out."""
    assert answer.upstream_tests(GRAPH, ["analysis.t.overview"]) == {
        "test.t.unique_int_fills_id": ["model.t.trades"],
        "test.t.unique_stg_fills_id": ["model.t.trades", "model.t.wallets"],
        "test.t.not_null_stg_markets_id": ["model.t.trades"],
        "test.t.not_null_fills_source": ["model.t.trades", "model.t.wallets"],
    }


BUILT = answer.Event("run-full", 100.0)


@pytest.mark.parametrize(
    "builds, passed, stale",
    [
        # Tested in the run that built the mart, before the mart itself: covered.
        ({"m": BUILT}, answer.Event("run-full", 90.0), False),
        # The mart was rebuilt alone afterwards, so newer rows reached it untested.
        ({"m": answer.Event("run-partial", 200.0)}, answer.Event("run-full", 90.0), True),
        # Tested again in a later run, over at least the rows the mart holds.
        ({"m": BUILT}, answer.Event("run-later", 150.0), False),
        # No Dagster record of the mart, as after a dbt build outside Dagster.
        ({"m": None}, answer.Event("run-full", 90.0), True),
        # The test never passed: no record, or its latest run failed or warned.
        ({"m": BUILT}, None, True),
    ],
)
def test_an_upstream_test_reruns_unless_it_passed_since_the_mart_was_built(builds, passed, stale):
    assert answer.stale_tests({"t": ["m"]}, builds, {"t": passed}) == (["t"] if stale else [])


def test_an_upstream_test_reruns_when_any_mart_it_feeds_was_built_after_it_passed():
    builds = {"trades": BUILT, "wallets": answer.Event("run-partial", 200.0)}
    assert answer.stale_tests({"t": ["trades", "wallets"]}, builds, {"t": answer.Event("run-full", 90.0)}) == ["t"]


def test_dagster_history_reads_the_marts_builds_and_the_tests_last_passes(monkeypatch):
    """A mart rebuilt alone after a full run: its build is the partial run's, and the upstream test's pass
    is the full run's, under the asset and check keys dagster-dbt gives them."""
    import dagster as dg

    @dg.asset(key="int_fills")
    def int_fills():
        return 1

    @dg.asset_check(asset=int_fills, name="unique_int_fills_id")
    def unique_int_fills_id():
        return dg.AssetCheckResult(passed=True)

    @dg.asset(key="trades", deps=[int_fills])
    def trades():
        return 2

    instance = dg.DagsterInstance.ephemeral()
    full = dg.materialize([int_fills, unique_int_fills_id, trades], instance=instance)
    partial = dg.materialize([int_fills, unique_int_fills_id, trades], instance=instance, selection=[trades.key])
    monkeypatch.setattr(dg.DagsterInstance, "get", staticmethod(lambda: instance))
    monkeypatch.setattr(answer, "asset_key", lambda manifest, unique_id: dg.AssetKey(unique_id.split(".")[-1]))
    monkeypatch.setattr(
        answer,
        "check_key",
        lambda manifest, unique_id: dg.AssetCheckKey(dg.AssetKey("int_fills"), unique_id.split(".")[-1]),
    )

    builds, passes = answer.dagster_history({}, {"test.t.unique_int_fills_id": ["model.t.trades"]})
    assert builds["model.t.trades"].run_id == partial.run_id
    assert passes["test.t.unique_int_fills_id"].run_id == full.run_id
    assert answer.stale_tests({"test.t.unique_int_fills_id": ["model.t.trades"]}, builds, passes) == [
        "test.t.unique_int_fills_id"
    ]


def test_dagster_keys_match_the_pipelines_for_a_model_and_a_test():
    """bj answer looks records up under the keys the pipeline's dbt assets write them under."""
    manifest = json.loads((Path(__file__).resolve().parents[2] / "transformation" / "target" / "manifest.json").read_text())
    model = next(uid for uid, n in manifest["nodes"].items() if n["resource_type"] == "model")
    generic = next(
        uid for uid, n in manifest["nodes"].items() if n["resource_type"] == "test" and n.get("attached_node") == model
    )
    name = manifest["nodes"][model]["name"]
    assert answer.asset_key(manifest, model).to_user_string() == name
    key = answer.check_key(manifest, generic)
    assert (key.asset_key.to_user_string(), key.name) == (name, manifest["nodes"][generic]["name"])


def test_coverage_reaches_dbt_test_as_a_var_only_when_there_is_some(monkeypatch):
    calls = []

    def dbt(project, *args):
        calls.append(args)
        return SimpleNamespace(exception=None, result=SimpleNamespace(results=[]))

    monkeypatch.setattr(answer, "dbt", dbt)
    answer.run_dbt_tests(Path("transformation"), ["usdc_flows"], {TRANSFERS: LOADED})
    answer.run_dbt_tests(Path("transformation"), ["eth_total"], {})
    flows, eth = calls
    assert flows[: flows.index("--vars")] == ("test", "--select", "1+usdc_flows", "+usdc_flows,tag:coverage", "--exclude", "tag:reference")
    assert json.loads(flows[flows.index("--vars") + 1]) == {"coverage": {TRANSFERS: LOADED.to_json()}}
    assert eth == ("test", "--select", "1+eth_total", "+eth_total,tag:coverage", "--exclude", "tag:reference")


def test_coverage_fails_naming_the_blocks_past_the_cursor(history, capsys):
    code, checks = history("{chain: ethereum, blocks: [100, 181]}", USDC_FLOWS)
    assert code == 1
    assert checks["coverage"] == ("failed", "ethereum.erc20_transfers (loaded 100-180): cursor 180 is before 181")
    assert "coverage: FAILED" in capsys.readouterr().out


def test_coverage_fails_naming_a_filter_address_the_source_did_not_load(history):
    code, checks = history("{chain: ethereum, blocks: [120, 150]}", f'[{{source: {TRANSFERS}, filter: {{wallets: ["0xdead"]}}}}]')
    assert code == 1
    assert checks["coverage"] == ("failed", "ethereum.erc20_transfers (loaded 100-180): wallets not in addresses.json: 0xdead")


def test_coverage_reports_a_source_that_has_loaded_nothing():
    check = answer.coverage_check([SourceInput(TRANSFERS, {})], {TRANSFERS: replace(LOADED, cursor=None)}, {"ethereum": (100, 100)})
    assert check == Check("coverage", False, "ethereum.erc20_transfers (nothing loaded): no run has saved a cursor")


def test_coverage_checks_each_input_against_the_blocks_of_its_chain():
    base = "base.erc20_transfers"
    loaded = {TRANSFERS: LOADED, base: replace(LOADED, source="base", raw_table="raw.base_erc20_transfers", start_block=5, cursor=9)}
    check = answer.coverage_check(
        [SourceInput(TRANSFERS, {}), SourceInput(base, {})], loaded, {"ethereum": (100, 180), "base": (5, 9)}
    )
    assert check == Check(
        "coverage",
        True,
        "ethereum.erc20_transfers (loaded 100-180) covers blocks 100-180 and the filter; "
        "base.erc20_transfers (loaded 5-9) covers blocks 5-9 and the filter",
    )


def test_coverage_passes_with_a_block_range_for_each_chain(history):
    code, checks = history("{blocks: {base: [5, 9], ethereum: [100, 180]}}", USDC_FLOWS)
    assert code == 0
    assert checks["coverage"] == ("passed", "ethereum.erc20_transfers (loaded 100-180) covers blocks 100-180 and the filter")


@pytest.mark.parametrize("window", ["{chain: base, blocks: [100, 180]}", "{blocks: {base: [100, 180]}}"])
def test_coverage_fails_when_the_window_has_no_blocks_for_the_chain_of_an_input(history, window):
    code, checks = history(window, USDC_FLOWS)
    assert code == 1
    assert checks["coverage"] == ("failed", "ethereum.erc20_transfers (loaded 100-180): window.blocks has no blocks for ethereum")


def test_a_stream_source_the_question_does_not_name_is_bad_input(history):
    with pytest.raises(BadInput, match="read the stream source ethereum.erc20_transfers; add an input with source: ethereum"):
        history("{chain: ethereum, blocks: [100, 180]}", "[{name: transfers, mart: erc20_transfers}]")


def test_a_stream_source_on_a_chain_outside_the_window_needs_no_input(history):
    code, checks = history("{blocks: {base: [100, 180]}}", "[{name: transfers, mart: erc20_transfers}]")
    assert code == 0
    assert "coverage" not in checks


def test_an_input_naming_a_source_that_is_not_a_stream_source_gets_no_coverage_check(tmp_path, offline):
    folder = write_question(tmp_path, extra='inputs: [{source: ethereum.eth_balances, filter: {wallets: ["0xdead"]}}]\n')
    offline(parked=0)
    assert answer.run(tmp_path, "eth-total") == 0
    assert "coverage" not in [c["name"] for c in json.loads((folder / "answer.json").read_text())["checks"]]


def test_an_input_naming_no_sources_entry_is_bad_input_before_any_write(tmp_path, offline):
    folder = write_question(tmp_path, extra="inputs: [{source: ethereum.erc20_transfer}]\n")
    offline(parked=0)
    with pytest.raises(BadInput, match=r"names ethereum\.erc20_transfer, which is not in SOURCES; stream sources: ethereum\.erc20_transfers$"):
        answer.run(tmp_path, "eth-total")
    assert sorted(p.name for p in folder.iterdir()) == ["question.yaml"]


def test_a_stream_input_needs_window_blocks(history):
    with pytest.raises(BadInput, match="inputs read the stream source ethereum.erc20_transfers, so set window.blocks"):
        history("{chain: ethereum}", USDC_FLOWS)


def test_the_window_reaches_dbt_compile_as_a_var_only_when_it_has_blocks(tmp_path, monkeypatch):
    manifest = {"nodes": {"analysis.t.usdc_flows": {"name": "usdc_flows", "resource_type": "analysis"}}, "sources": {}}
    calls = []

    def dbt(project, *args):
        calls.append(args)
        target = Path(args[args.index("--target-path") + 1])
        (target / "manifest.json").write_text(json.dumps(manifest))
        return SimpleNamespace(success=True)

    monkeypatch.setattr(answer, "dbt", dbt)
    answer.compile_analyses(tmp_path, ["usdc_flows"], {"ethereum": (100, 180), "base": (5, 9)})
    answer.compile_analyses(tmp_path, ["usdc_flows"], {})
    flows, latest = calls
    assert flows[: flows.index("--vars")] == ("compile", "--select", "usdc_flows")
    assert json.loads(flows[flows.index("--vars") + 1]) == {"window": {"ethereum": [100, 180], "base": [5, 9]}}
    assert latest[:latest.index("--target-path")] == ("compile", "--select", "usdc_flows")


EVAL_SLICE = "eval_window: {chain: ethereum, blocks: [100, 180]}\n"


def test_eval_answer_and_factory_check_leave_the_full_answer_unchanged(tmp_path, offline, monkeypatch):
    from pipeline.cli import main

    folder = write_question(tmp_path, extra=EVAL_SLICE)
    offline(parked=0)
    assert answer.run(tmp_path, "eth-total") == 0
    before = (folder / "answer.json").read_bytes()
    (folder / "answer.md").write_text("The full answer.")
    assert answer.run(tmp_path, "eth-total", "eval_window") == 0
    assert (folder / "answer.json").read_bytes() == before
    assert (folder / "answer.md").read_text() == "The full answer."
    evaluation = folder / "eval" / "answer.json"
    assert json.loads(evaluation.read_text())["eval"] is True
    monkeypatch.setattr("pipeline.cli.REPO_ROOT", tmp_path)
    # The workflow's shell steps and legacy CLI branch are covered in test_factory_eval_compatibility.
    assert main(["check", "eth-total", "--eval", "reference_match", "passed", "matches oracle"]) == 0
    assert json.loads(evaluation.read_text())["checks"][-1]["name"] == "reference_match"
    assert (folder / "answer.json").read_bytes() == before


def test_an_eval_run_compiles_checks_coverage_and_records_the_eval_window(tmp_path, history):
    code, checks = history("{chain: ethereum, blocks: [100, 500]}", USDC_FLOWS, EVAL_SLICE, "eval_window")
    assert code == 0
    assert history.compiled == [{"ethereum": (100, 180)}]
    assert checks["coverage"] == ("passed", "ethereum.erc20_transfers (loaded 100-180) covers blocks 100-180 and the filter")
    doc = json.loads((tmp_path / "answers" / "usdc-flows" / "eval" / "answer.json").read_text())
    assert (doc["window"], doc["eval"]) == ({"chain": "ethereum", "blocks": [100, 180]}, True)


def test_a_full_run_of_the_same_question_needs_the_whole_window_loaded(history):
    code, checks = history("{chain: ethereum, blocks: [100, 500]}", USDC_FLOWS, EVAL_SLICE)
    assert code == 1
    assert history.compiled == [{"ethereum": (100, 500)}]
    assert checks["coverage"][0] == "failed"

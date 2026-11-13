"""Contracts and actual PostgreSQL snapshot/export behavior, with no provider calls."""
import csv
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import psycopg2
import pytest

from pipeline.analysis.domain import Check, Input, LastRun
from pipeline.analysis.executor import read_warehouse
from pipeline.analysis.runner import apply_freshness_policy
from pipeline.analysis.spec import ExecutionPolicy, parameters, execution_policy
from pipeline.cli import BadInput
from pipeline.cli.question import Question


def test_recursive_parameter_validation_preserves_nested_dbt_variables():
    schema = {"token": {"type": "object", "properties": {
        "decimals": {"type": "integer", "required": True},
        "windows": {"type": "array", "items": {"type": "object", "properties": {
            "chain": {"type": "string"}, "blocks": {"type": "array", "items": "integer"}}}}},
        "default": {"decimals": 18, "windows": [{"chain": "ethereum", "blocks": [1, 2]}]}}}
    assert parameters(schema, {}) == {"token": schema["token"]["default"]}
    with pytest.raises(BadInput, match="decimals must be integer"):
        parameters(schema, {"token": {"decimals": True}})
    with pytest.raises(BadInput, match="unknown properties"):
        parameters(schema, {"token": {"decimals": 18, "secret": 1}})
    with pytest.raises(BadInput, match="reserved"):
        parameters({"window": {"type": "string", "default": "bad"}}, {})


@pytest.mark.parametrize("policy", [{"fetch_size": 0}, {"max_rows": True}, {"statement_timeout_ms": -1}, {"fetch_size": 100001}])
def test_execution_limits_are_validated(policy):
    with pytest.raises(BadInput):
        execution_policy(policy)


@pytest.fixture
def pg(monkeypatch):
    import os
    required = ["WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB"]
    if not all(os.environ.get(name) for name in required):
        pytest.skip("requires disposable WAREHOUSE_* PostgreSQL fixture")
    from pipeline.warehouse import connect
    connection = connect()
    connection.autocommit = True
    schema = "runtime_" + uuid4().hex
    with connection.cursor() as cursor:
        cursor.execute(f'create schema "{schema}"')
        cursor.execute(f'create table "{schema}".facts (n integer)')
        cursor.execute(f'insert into "{schema}".facts select generate_series(1, 5000)')
    monkeypatch.setenv("RAW_SCHEMA", schema)
    yield connect, connection, schema
    with connection.cursor() as cursor:
        cursor.execute(f'drop schema "{schema}" cascade')
    connection.close()


def manifest_for(schema, *queries):
    nodes = {f"analysis.test.q{i}": {"name": f"q{i}", "resource_type": "analysis", "compiled_code": query,
                                  "depends_on": {"nodes": ["source.test.facts"]}} for i, query in enumerate(queries)}
    return {"nodes": nodes, "sources": {"source.test.facts": {"name": "facts", "identifier": "facts", "schema": schema,
            "resource_type": "source"}}}, list(nodes)


def test_real_pg_complete_export_is_spooled_and_limits_fail_without_partial_answer(pg):
    connect, _, schema = pg
    manifest, ids = manifest_for(schema, f'select n from "{schema}".facts order by n')
    results, _, _ = read_warehouse(connect, manifest, ids, [], policy=ExecutionPolicy(fetch_size=37))
    try:
        assert results[0].row_count == 5000
        assert len(results[0].rows) == 2
        with results[0].csv_path.open() as file:
            rows = list(csv.reader(file))
        assert len(rows) == 5001 and rows[-1] == ["5000"]
        assert results.context["isolation"] == "repeatable read"
        assert results.context["locked_relations"] == [f"{schema}.facts"]
    finally:
        results.close()
    with pytest.raises(BadInput, match="max_rows=100"):
        read_warehouse(connect, manifest, ids, [], policy=ExecutionPolicy(max_rows=100, fetch_size=37))
    with pytest.raises(BadInput, match="expected_columns"):
        read_warehouse(connect, manifest, ids, [], expected_columns={"q0": ["wrong"]})


def test_real_pg_queries_share_snapshot_and_block_relation_replacement(pg):
    connect, writer, schema = pg
    manifest, ids = manifest_for(schema, f'select count(*) from "{schema}".facts', f'select count(*) from "{schema}".facts')
    changed = False
    class Cursor:
        def __init__(self, cursor): self.cursor = cursor
        def __getattr__(self, name): return getattr(self.cursor, name)
        def __enter__(self): self.cursor.__enter__(); return self
        def __exit__(self, *args): return self.cursor.__exit__(*args)
        def fetchmany(self, count):
            nonlocal changed
            rows = self.cursor.fetchmany(count)
            if not changed:
                changed = True
                with writer.cursor() as cursor:
                    cursor.execute(f'insert into "{schema}".facts values (5001)')
                    cursor.execute("set lock_timeout='50ms'")
                    with pytest.raises(psycopg2.errors.LockNotAvailable):
                        cursor.execute(f'alter table "{schema}".facts rename to replacement')
            return rows
    class Connection:
        def __init__(self): self.connection = connect()
        def __getattr__(self, name): return getattr(self.connection, name)
        def cursor(self, *args, **kwargs):
            cursor = self.connection.cursor(*args, **kwargs)
            return Cursor(cursor) if kwargs.get("name") else cursor
    results, _, _ = read_warehouse(Connection, manifest, ids, [])
    try:
        assert [r.rows for r in results] == [[(5000,)], [(5000,)]]
    finally:
        results.close()
    with writer.cursor() as cursor:
        cursor.execute(f'select count(*) from "{schema}".facts')
        assert cursor.fetchone() == (5001,)


def test_real_pg_statement_timeout_is_enforced(pg):
    connect, _, schema = pg
    manifest, ids = manifest_for(schema, "select pg_sleep(0.1)")
    with pytest.raises(BadInput, match="statement timeout"):
        read_warehouse(connect, manifest, ids, [], policy=ExecutionPolicy(statement_timeout_ms=10))


def test_age_and_model_build_policy_reports_stale_inputs_and_builds():
    now = datetime.now(timezone.utc)
    source = Input("test", "facts", "raw.facts")
    question = Question("q", "Q", None, {}, (), {}, (), (), ("q",), freshness={"max_age_hours": 1, "require_model_build": True})
    manifest = {"nodes": {"model.test.m": {"resource_type": "model", "config": {"materialized": "table"}}}}
    context = {"model_builds": {"model.test.m": {"status": "success", "started_at": (now-timedelta(hours=3)).isoformat(), "finished_at": (now-timedelta(hours=3)).isoformat()}}}
    check = apply_freshness_policy(Check("freshness", True, "loaded"), question,
                                  {source: LastRun(now-timedelta(hours=2), 1, None)}, context, manifest, ["model.test.m"])
    assert not check.passed
    assert "exceeds 1 hours" in check.detail and "before the latest input load" in check.detail


def test_lineage_finds_native_reads_mixed_with_a_declared_ref_and_ignores_ctes():
    from pipeline.analysis.lineage import unknown_lineage
    manifest, ids = manifest_for("raw", 'with x as (select * from raw.facts) select * from x join raw.hidden using (n)')
    assert unknown_lineage(manifest, ids) == ["q0: undeclared relation raw.hidden"]
    manifest["nodes"][ids[0]]["compiled_code"] = 'with x as (select * from raw.facts) select * from x'
    assert unknown_lineage(manifest, ids) == []
    manifest["nodes"][ids[0]]["depends_on"]["nodes"] = []
    assert "no declared dependencies" in unknown_lineage(manifest, ids)[0]


def test_real_pg_column_types_and_grain_contracts(pg):
    connect, _, schema = pg
    manifest, ids = manifest_for(schema, f'select n from "{schema}".facts order by n')
    results, _, _ = read_warehouse(connect, manifest, ids, [], expected_columns={"q0": [{"name": "n", "type": "integer"}]}, grain={"q0": ["n"]})
    results.close()
    with pytest.raises(BadInput, match="type int4 does not match text"):
        read_warehouse(connect, manifest, ids, [], expected_columns={"q0": [{"name": "n", "type": "text"}]})
    manifest["nodes"][ids[0]]["compiled_code"] = f'select n % 10 as n from "{schema}".facts'
    with pytest.raises(BadInput, match="duplicate grain"):
        read_warehouse(connect, manifest, ids, [], grain={"q0": ["n"]})


def test_loaded_question_hash_survives_edit_while_queries_are_running(tmp_path):
    import hashlib
    from pipeline.cli.question import load_question
    from pipeline.analysis.provenance import run_provenance
    folder = tmp_path / "answers" / "q"
    folder.mkdir(parents=True)
    authored = b"question: Original\n"
    (folder / "question.yaml").write_bytes(authored)
    question = load_question(tmp_path, "q")
    (folder / "question.yaml").write_text("question: Edited during execution\n")
    provenance = run_provenance(tmp_path, question, {"nodes": {}, "sources": {}}, [], [], {}, None, None)
    assert provenance["question_sha256"] == hashlib.sha256(authored).hexdigest()


def test_all_existing_compiled_analyses_have_complete_declared_lineage():
    import json
    import os
    from pipeline.analysis.lineage import unknown_lineage
    from pipeline.cli.answer import compile_analyses
    if not all(os.environ.get(key) for key in ("WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_DB", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "RAW_SCHEMA", "DBT_SCHEMA")):
        pytest.skip("catalog lineage validation compiles real SQL against disposable WAREHOUSE_* configuration")
    project = Path(__file__).resolve().parents[2] / "transformation"
    manifest = json.loads((project / "target" / "manifest.json").read_text())
    names = [node["name"] for node in manifest["nodes"].values() if node["resource_type"] == "analysis"]
    compiled, analyses = compile_analyses(project, names, {})
    assert len(analyses) == len(names) and analyses
    assert all(compiled["nodes"][uid].get("compiled_code") for uid in analyses)
    assert unknown_lineage(compiled, analyses) == []


def test_lock_backend_on_windows_retries_and_releases(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    from pipeline.analysis import store
    calls = []
    def locking(fd, mode, length):
        calls.append(mode)
        if len(calls) == 1:
            raise PermissionError(13, "busy")
    monkeypatch.setattr(store, "os", SimpleNamespace(name="nt"))
    monkeypatch.setattr(store.time, "sleep", lambda delay: None)
    monkeypatch.setitem(sys.modules, "msvcrt", SimpleNamespace(locking=locking, LK_NBLCK=1, LK_UNLCK=2))
    with store.answer_lock(tmp_path):
        with store.answer_lock(tmp_path, shared=True):
            assert calls == [1, 1]
    assert calls == [1, 1, 2]


def test_real_pg_grain_uses_numeric_equality_not_decimal_display_scale(pg):
    connect, _, schema = pg
    manifest, ids = manifest_for(schema, 'select amount from (values (1.0::numeric), (1.00::numeric)) t(amount)')
    with pytest.raises(BadInput, match="duplicate grain"):
        read_warehouse(connect, manifest, ids, [], grain={"q0": ["amount"]})


@pytest.mark.parametrize("contract", ["expected_columns: {typo: [amount]}", "grain: {typo: [amount]}"])
def test_contract_keys_must_name_a_resolved_analysis(tmp_path, contract):
    from pipeline.cli.question import load_question
    folder = tmp_path / "answers" / "my-analysis"
    folder.mkdir(parents=True)
    (folder / "question.yaml").write_text(f"question: Q\n{contract}\n")
    with pytest.raises(BadInput, match="undeclared analyses: typo"):
        load_question(tmp_path, "my-analysis")
    (folder / "question.yaml").write_text(f"question: Q\n{contract.replace('typo', 'my_analysis')}\n")
    assert load_question(tmp_path, "my-analysis").analyses == ("my_analysis",)


def test_lineage_folds_only_unquoted_postgres_identifiers():
    from pipeline.analysis.lineage import unknown_lineage
    manifest, ids = manifest_for("raw", "select * from RAW.FACTS")
    assert unknown_lineage(manifest, ids) == []
    manifest["nodes"][ids[0]]["compiled_code"] = "WITH X AS (SELECT * FROM RAW.FACTS) SELECT * FROM x"
    assert unknown_lineage(manifest, ids) == []
    manifest["nodes"][ids[0]]["compiled_code"] = 'select * from "RAW"."FACTS"'
    assert "undeclared relation" in unknown_lineage(manifest, ids)[0]
    manifest["nodes"][ids[0]].pop("compiled_code")
    assert "compiled SQL is missing" in unknown_lineage(manifest, ids)[0]


def token_question(tmp_path):
    import yaml
    folder = tmp_path / "answers" / "token-total"
    folder.mkdir(parents=True)
    asset = "0x" + "1" * 40
    l1_asset = "0x" + "2" * 40
    token = {"ethereum": l1_asset, "decimals": 18, "windows": [{"chain": "arbitrum", "token": asset, "blocks": [100, 200]}]}
    window_schema = {"type": "object", "properties": {
        "chain": {"type": "string", "required": True}, "token": {"type": "string", "required": True},
        "blocks": {"type": "array", "items": "integer", "required": True}}}
    token_schema = {"type": "object", "properties": {
        "ethereum": {"type": "string", "required": True}, "decimals": {"type": "integer", "required": True},
        "windows": {"type": "array", "items": window_schema}}, "default": token}
    raw = {"question": "Token total", "parameter_scope": "token_windows", "window": {"blocks": {"arbitrum": [100, 200]}},
           "inputs": [{"source": "arbitrum.erc20_transfers", "filter": {"tokens": [asset]}},
                      {"source": "arbitrum.token_bridge", "filter": {"tokens": [l1_asset]}}],
           "parameters": {"token": token_schema}}
    def save():
        (folder / "question.yaml").write_text(yaml.safe_dump(raw))
    save()
    return raw, save


@pytest.mark.parametrize("change", ["blocks", "asset", "bridge"])
def test_supported_token_scope_mismatch_fails_bj_answer_before_compiling(tmp_path, monkeypatch, change):
    import copy
    from pipeline.cli import answer
    raw, save = token_question(tmp_path)
    token = copy.deepcopy(raw["parameters"]["token"]["default"])
    if change == "blocks": token["windows"][0]["blocks"] = [1, 2]
    if change == "asset": token["windows"][0]["token"] = "0x" + "3" * 40
    if change == "bridge": token["ethereum"] = "0x" + "3" * 40
    raw["values"] = {"token": token}
    save()
    monkeypatch.setattr(answer, "compile_analyses", lambda *args, **kwargs: pytest.fail("scope mismatch reached compilation"))
    with pytest.raises(BadInput, match="match"):
        answer.run(tmp_path, "token-total")


def test_token_eval_requires_explicit_matching_typed_scope_and_preserves_full_defaults(tmp_path):
    import copy
    from pipeline.cli.question import load_question
    raw, save = token_question(tmp_path)
    raw["eval_window"] = {"blocks": {"arbitrum": [120, 125]}}
    save()
    with pytest.raises(BadInput, match="eval_values"):
        load_question(tmp_path, "token-total", "eval_window")
    token = copy.deepcopy(raw["parameters"]["token"]["default"])
    token["windows"][0]["blocks"] = [120, 125]
    raw["eval_values"] = {"token": token}
    save()
    evaluated = load_question(tmp_path, "token-total", "eval_window")
    full = load_question(tmp_path, "token-total")
    assert evaluated.parameters["token"]["windows"][0]["blocks"] == [120, 125]
    assert full.parameters["token"]["windows"][0]["blocks"] == [100, 200]
    raw["eval_values"]["token"]["windows"][0]["blocks"] = [True, 125]
    save()
    with pytest.raises(BadInput, match="must be integer"):
        load_question(tmp_path, "token-total", "eval_window")

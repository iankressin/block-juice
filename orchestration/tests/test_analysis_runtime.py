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
    from pipeline.analysis.lineage import unknown_lineage
    target = Path(__file__).resolve().parents[2] / "transformation" / "target" / "manifest.json"
    manifest = json.loads(target.read_text())
    analyses = [uid for uid, node in manifest["nodes"].items() if node["resource_type"] == "analysis"]
    assert analyses
    assert unknown_lineage(manifest, analyses) == []


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

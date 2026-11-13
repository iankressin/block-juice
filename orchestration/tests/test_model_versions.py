"""Optional build-version evidence must never break existing warehouse run logging."""
import copy
import hashlib
import logging
from contextlib import closing
from pathlib import Path

import psycopg2
import pytest

from test_run_log import RUN_RESULTS, STARTED
from test_warehouse import scratch
from pipeline.analysis.executor import model_builds
from pipeline.run_log import record_dbt_build

UID = "model.transformation.latest_balances"
SQL = "select 17::numeric as balance"
MANIFEST = {"metadata": {"invocation_id": RUN_RESULTS["metadata"]["invocation_id"]}, "nodes": {
    UID: {"resource_type": "model", "compiled_code": SQL, "raw_code": "select {{ var('amount') }}::numeric as balance",
          "config": {"materialized": "table", "schema": "analytics"}, "checksum": {"name": "sha256", "checksum": "source-checksum"}}
}}


class Invocation:
    def __init__(self, manifest=MANIFEST):
        self.manifest = manifest
    def get_error(self):
        return None
    def get_artifact(self, name):
        if name == "run_results.json":
            return RUN_RESULTS
        if name == "manifest.json" and self.manifest is not None:
            return self.manifest
        raise FileNotFoundError(name)


@pytest.fixture
def ops(scratch, monkeypatch):
    monkeypatch.setenv("WAREHOUSE_DB", scratch["dbname"])
    statements = (Path(__file__).resolve().parents[2] / "infra" / "postgres" / "ops.sql").read_text()
    def execute(statement):
        with closing(psycopg2.connect(**scratch)) as connection, connection, connection.cursor() as cursor:
            cursor.execute(statement)
            return cursor.fetchall() if cursor.description else None
    execute("drop schema if exists ops cascade")
    execute(statements)
    execute(statements)  # bootstrap remains idempotent
    return execute


def record(manifest=MANIFEST):
    record_dbt_build(logging.getLogger("test.model_versions"), "run-1", Invocation(manifest), STARTED)


def read_build(scratch):
    with closing(psycopg2.connect(**scratch)) as connection, connection.cursor() as cursor:
        return model_builds(cursor, MANIFEST, [UID])[UID]


def assert_core_log(ops):
    assert ops("select count(*) from ops.dbt_invocations") == [(1,)]
    assert ops("select count(*) from ops.dbt_node_runs") == [(4,)]


def test_new_schema_records_actual_build_artifact_hashes(ops, scratch):
    record()
    assert_core_log(ops)
    version = read_build(scratch)["version"]
    assert version["status"] == "recorded"
    assert version["compiled_sql_sha256"] == hashlib.sha256(SQL.encode()).hexdigest()
    assert version["source_checksum"] == {"name": "sha256", "checksum": "source-checksum"}
    assert len(version["config_sha256"]) == 64
    assert len(version["manifest_sha256"]) == 64
    assert ops("select count(*) from ops.dbt_node_versions") == [(1,)]


def test_old_ops_schema_retains_core_logging_and_reports_version_unknown(ops, scratch):
    ops("drop table ops.dbt_node_versions")
    record()
    assert_core_log(ops)
    assert read_build(scratch)["version"]["status"] == "unknown"


def test_optional_version_write_failure_does_not_rollback_run_log(ops, scratch, caplog):
    ops("alter table ops.dbt_node_versions add constraint reject_fixture check (provenance->>'config_sha256' = 'reject')")
    record()
    assert_core_log(ops)
    assert read_build(scratch)["version"]["status"] == "unknown"
    assert "run log retained" in caplog.text


def test_a_manifest_from_another_invocation_cannot_certify_a_build(ops, scratch, caplog):
    other = copy.deepcopy(MANIFEST)
    other["metadata"]["invocation_id"] = "00000000-0000-0000-0000-000000000000"
    record(other)
    assert_core_log(ops)
    assert read_build(scratch)["version"]["status"] == "unknown"
    assert "does not match" in caplog.text


def test_missing_manifest_is_unknown_without_breaking_legacy_logging(ops, scratch):
    record(None)
    assert_core_log(ops)
    assert read_build(scratch)["version"]["status"] == "unknown"


def test_ingestion_input_evidence_is_optional_and_bound_to_exact_run_and_source(ops, scratch, monkeypatch):
    import json
    from pipeline.analysis.executor import ingestion_inputs
    monkeypatch.setenv("RAW_SCHEMA", "raw")
    run_id = RUN_RESULTS["metadata"]["invocation_id"]
    runs = {"ethereum.erc20_balances": {"run_id": run_id, "source_table": "ethereum_erc20_balances"}}
    def read():
        with closing(psycopg2.connect(**scratch)) as connection, connection.cursor() as cursor:
            return ingestion_inputs(cursor, runs)["ethereum.erc20_balances"]
    ops("drop schema if exists raw cascade; create schema raw")
    assert read()["status"] == "unknown"
    ops("create table raw._ingestion_inputs (run_id text, source_table text, config_hash text, evidence jsonb, primary key(run_id,source_table))")
    assert read()["status"] == "unknown"
    with closing(psycopg2.connect(**scratch)) as connection, connection, connection.cursor() as cursor:
        cursor.execute("insert into raw._ingestion_inputs values (%s,%s,%s,%s::jsonb)",
                       (run_id, "other_table", "wrong", json.dumps({"version": 1})))
    assert read()["status"] == "unknown"
    evidence = {"version": 1, "scope": "ingestion_run", "files": {"addresses.json": [{"sha256": "a"*64, "bytes": 20}]}}
    with closing(psycopg2.connect(**scratch)) as connection, connection, connection.cursor() as cursor:
        cursor.execute("insert into raw._ingestion_inputs values (%s,%s,%s,%s::jsonb)",
                       (run_id, "ethereum_erc20_balances", "config-fingerprint", json.dumps(evidence)))
    result = read()
    assert result["status"] == "recorded"
    assert result["run_id"] == run_id and result["scope"] == "ingestion_run"
    assert result["config_hash"] == "config-fingerprint"
    assert result["evidence"] == evidence


def test_result_snapshot_joins_input_evidence_to_last_successful_run(ops, scratch, monkeypatch):
    from pipeline.analysis.domain import Input
    from pipeline.analysis.executor import read_warehouse
    monkeypatch.setenv("RAW_SCHEMA", "raw")
    run_id = RUN_RESULTS["metadata"]["invocation_id"]
    ops("drop schema if exists raw cascade; create schema raw; create table raw.ethereum_erc20_balances(n integer); "
        "insert into raw.ethereum_erc20_balances values (17); "
        "create table raw._ingestion_inputs (run_id text, source_table text, config_hash text, evidence jsonb)")
    with closing(psycopg2.connect(**scratch)) as connection, connection, connection.cursor() as cursor:
        cursor.execute("insert into ops.ingestion_runs (run_id,source,table_name,started_at,finished_at,succeeded,records_written,failed_calls,retried_calls,load_seconds) "
                       "values (%s,'ethereum','erc20_balances',now(),now(),true,1,0,0,0)", (run_id,))
        cursor.execute("insert into raw._ingestion_inputs values (%s,'ethereum_erc20_balances','exact-config','{\"scope\":\"ingestion_run\"}')", (run_id,))
    source = Input("ethereum", "erc20_balances", "raw.ethereum_erc20_balances")
    manifest = {"sources": {"source.test.balances": {"resource_type": "source", "source_name": "ethereum", "name": "erc20_balances",
                "schema": "raw", "identifier": "ethereum_erc20_balances"}},
                "nodes": {"analysis.test.q": {"name": "q", "resource_type": "analysis", "compiled_code": "select n from raw.ethereum_erc20_balances",
                          "depends_on": {"nodes": ["source.test.balances"]}}}}
    results, dead_letters, runs = read_warehouse(lambda: psycopg2.connect(**scratch), manifest, ["analysis.test.q"], [source])
    try:
        assert results[0].rows == [(17,)] and runs[source].records_written == 1
        assert dead_letters[source] == (0, 0)
        evidence = results.context["ingestion_inputs"][source.name]
        assert evidence["run_id"] == run_id and evidence["config_hash"] == "exact-config"
    finally:
        results.close()

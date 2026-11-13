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

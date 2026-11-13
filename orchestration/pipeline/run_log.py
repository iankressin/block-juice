"""Writes each dbt invocation to ops.dbt_invocations and ops.dbt_node_runs (infra/postgres/init.sql)."""

import logging
import hashlib
import json
import uuid
from contextlib import closing
from dataclasses import astuple, dataclass
from datetime import datetime, timezone
from typing import Any

from dagster_dbt.core.dbt_cli_invocation import DbtCliInvocation
from psycopg2.extras import execute_values, Json

from pipeline.warehouse import connect

# Resource types whose adapter_response.rows_affected counts rows they wrote.
WRITES_ROWS = {"model", "seed", "snapshot"}


@dataclass(frozen=True)
class DbtInvocation:
    invocation_id: str
    dagster_run_id: str | None
    command: str
    started_at: datetime
    finished_at: datetime
    succeeded: bool
    dbt_version: str | None
    error: str | None


@dataclass(frozen=True)
class DbtNodeRun:
    invocation_id: str
    unique_id: str
    resource_type: str
    name: str
    status: str
    started_at: datetime | None
    finished_at: datetime | None
    execution_seconds: float
    rows_affected: int | None
    failures: int | None
    message: str | None


def parse_time(value: str) -> datetime:
    # dbt writes UTC times ending in Z, and leaves out the fraction when it is zero.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def dbt_run_rows(
    run_results: dict[str, Any] | None,
    *,
    dagster_run_id: str | None,
    command: str,
    started_at: datetime,
    finished_at: datetime,
    error: str | None,
) -> tuple[DbtInvocation, list[DbtNodeRun]]:
    """run_results is None when dbt failed before it wrote run_results.json, so no node ran."""
    metadata = (run_results or {}).get("metadata", {})
    invocation_id = metadata.get("invocation_id") or str(uuid.uuid4())
    invocation = DbtInvocation(
        invocation_id=invocation_id,
        dagster_run_id=dagster_run_id,
        command=command,
        started_at=started_at,
        finished_at=finished_at,
        succeeded=error is None,
        dbt_version=metadata.get("dbt_version"),
        error=error,
    )
    nodes = []
    for result in (run_results or {}).get("results", []):
        resource_type, _package, name = result["unique_id"].split(".")[:3]
        timing = result.get("timing", [])
        rows = (result.get("adapter_response") or {}).get("rows_affected")
        nodes.append(
            DbtNodeRun(
                invocation_id=invocation_id,
                unique_id=result["unique_id"],
                resource_type=resource_type,
                name=name,
                status=result["status"],
                started_at=min((parse_time(t["started_at"]) for t in timing if t.get("started_at")), default=None),
                finished_at=max((parse_time(t["completed_at"]) for t in timing if t.get("completed_at")), default=None),
                execution_seconds=result["execution_time"],
                rows_affected=rows if resource_type in WRITES_ROWS and rows is not None and rows >= 0 else None,
                failures=result.get("failures") if resource_type == "test" else None,
                message=result.get("message"),
            )
        )
    return invocation, nodes



def node_versions(manifest: dict, invocation_id: str, nodes: list[DbtNodeRun]) -> list[tuple]:
    """Hashes from the build's own artifact, never from the checkout's later analysis manifest."""
    if manifest.get("metadata", {}).get("invocation_id") != invocation_id:
        raise ValueError("build manifest invocation_id does not match run_results")
    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    manifest_hash = digest(manifest)
    result = []
    for run in nodes:
        node = manifest.get("nodes", {}).get(run.unique_id)
        if not node or run.resource_type not in WRITES_ROWS or run.status == "skipped":
            continue
        code = node.get("compiled_code")
        raw = node.get("raw_code")
        evidence = {
            "manifest_sha256": manifest_hash,
            "compiled_sql_sha256": hashlib.sha256(code.encode()).hexdigest() if isinstance(code, str) else None,
            "raw_code_sha256": hashlib.sha256(raw.encode()).hexdigest() if isinstance(raw, str) else None,
            "config_sha256": digest(node["config"]) if "config" in node else None,
            "source_checksum": node.get("checksum"),
        }
        result.append((invocation_id, run.unique_id, Json(evidence)))
    return result


def record_node_versions(cursor, log, invocation, row, nodes):
    """Optional evidence may be unavailable on an old ops schema; core run logging still commits."""
    cursor.execute("savepoint optional_node_versions")
    try:
        cursor.execute("select to_regclass('ops.dbt_node_versions')")
        if cursor.fetchone()[0] is None:
            return
        manifest = invocation.get_artifact("manifest.json")
        versions = node_versions(manifest, row.invocation_id, nodes)
        if versions:
            execute_values(cursor, "insert into ops.dbt_node_versions (invocation_id, unique_id, provenance) values %s", versions)
    except Exception as error:
        cursor.execute("rollback to savepoint optional_node_versions")
        log.warning(f"Could not record dbt model version evidence (run log retained): {error}")
    finally:
        cursor.execute("release savepoint optional_node_versions")


def record_dbt_build(
    log: logging.Logger, dagster_run_id: str, invocation: DbtCliInvocation, started_at: datetime
) -> None:
    """Never raises: a dbt build keeps its own result when its log rows cannot be written."""
    try:
        finished_at = datetime.now(timezone.utc)
        error = invocation.get_error()
        try:
            run_results = invocation.get_artifact("run_results.json")
        except FileNotFoundError:
            run_results = None
        row, nodes = dbt_run_rows(
            run_results,
            dagster_run_id=dagster_run_id,
            command="build",
            started_at=started_at,
            finished_at=finished_at,
            error=str(error) if error else None,
        )
        with closing(connect()) as connection, connection, connection.cursor() as cursor:
            cursor.execute(
                "insert into ops.dbt_invocations (invocation_id, dagster_run_id, command, started_at,"
                " finished_at, succeeded, dbt_version, error) values (%s, %s, %s, %s, %s, %s, %s, %s)",
                astuple(row),
            )
            if nodes:
                execute_values(
                    cursor,
                    "insert into ops.dbt_node_runs (invocation_id, unique_id, resource_type, name, status,"
                    " started_at, finished_at, execution_seconds, rows_affected, failures, message) values %s",
                    [astuple(node) for node in nodes],
                )
                record_node_versions(cursor, log, invocation, row, nodes)
    except Exception as error:
        log.warning(f"Could not record the dbt run in ops.dbt_invocations: {error}")

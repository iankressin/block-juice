"""Read one pinned warehouse snapshot and spool complete query results in bounded memory."""
import csv
import os
import sqlite3
import json
from decimal import Decimal
from contextlib import closing
from tempfile import TemporaryDirectory
from pathlib import Path
from uuid import uuid4

import psycopg2
from psycopg2 import sql

from pipeline.analysis.domain import Result, LastRun, cell_text, jsonable
from pipeline.analysis.spec import ExecutionPolicy
from pipeline.cli import BadInput, utc_iso


def grain_key(value):
    """Canonical values for disk uniqueness, independent of numeric display scale or JSON key order."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float, Decimal)):
        number = value if isinstance(value, Decimal) else Decimal(str(value))
        if not number.is_finite():
            return ["number", str(number)]
        if not number:
            return ["number", "0"]
        sign, digits, exponent = number.as_tuple()
        digits = list(digits)
        while digits[-1] == 0:
            digits.pop()
            exponent += 1
        return ["number", ("-" if sign else "") + "".join(map(str, digits)) + "e" + str(exponent)]
    if isinstance(value, dict):
        return ["object", [[key, grain_key(item)] for key, item in sorted(value.items())]]
    if isinstance(value, (list, tuple)):
        return ["array", [grain_key(item) for item in value]]
    return ["scalar", jsonable(value)]


class Results(list):
    """Results own their temporary CSVs until the runner has published them."""
    def __init__(self):
        super().__init__()
        self.temporary = TemporaryDirectory(prefix="bj-results-")
        self.context = {}

    def close(self):
        self.temporary.cleanup()


def ancestors(manifest, analysis_ids):
    seen, stack = set(), list(analysis_ids)
    while stack:
        uid = stack.pop()
        if uid in seen:
            continue
        seen.add(uid)
        node = manifest.get("nodes", {}).get(uid, manifest.get("sources", {}).get(uid, {}))
        stack.extend(node.get("depends_on", {}).get("nodes", []))
    return seen


def relations(manifest, analysis_ids):
    found = set()
    for uid in ancestors(manifest, analysis_ids):
        node = manifest.get("nodes", {}).get(uid, manifest.get("sources", {}).get(uid, {}))
        if node.get("resource_type") not in {"model", "seed", "source", "snapshot"}:
            continue
        if node.get("config", {}).get("materialized") == "ephemeral":
            continue
        identifier = node.get("alias", node.get("identifier", node.get("name")))
        if node.get("schema") and identifier:
            found.add((node["schema"], identifier))
    return sorted(found)


def count_dead_letters(cursor, source_table):
    schema = os.environ["RAW_SCHEMA"]
    cursor.execute("select to_regclass(%s)", (f'"{schema}"._dead_letters',))
    if cursor.fetchone()[0] is None:
        return 0, 0
    cursor.execute(sql.SQL("select count(*) filter (where not parked), count(*) filter (where parked) "
                          "from {}._dead_letters where source_table = %s").format(sql.Identifier(schema)), (source_table,))
    return tuple(cursor.fetchone())


def model_builds(cursor, manifest, analysis_ids):
    ids = sorted(uid for uid in ancestors(manifest, analysis_ids) if uid.startswith("model."))
    cursor.execute("select to_regclass('ops.dbt_node_runs')")
    if cursor.fetchone()[0] is None or not ids:
        return {}
    cursor.execute("select distinct on (unique_id) unique_id, invocation_id::text, started_at, finished_at, status "
                   "from ops.dbt_node_runs where unique_id = any(%s) and finished_at is not null "
                   "order by unique_id, finished_at desc, invocation_id", (ids,))
    return {uid: {"invocation_id": invocation, "started_at": utc_iso(started) if started else None,
                  "finished_at": utc_iso(finished), "status": status}
            for uid, invocation, started, finished, status in cursor.fetchall()}


def read_warehouse(connect, manifest, analysis_ids, inputs, *, policy=None, expected_columns=None, grain=None):
    policy = policy or ExecutionPolicy()
    expected_columns = expected_columns or {}
    grain = grain or {}
    results = Results()
    try:
        with closing(connect()) as connection:
            connection.set_session(readonly=True, isolation_level="REPEATABLE READ")
            with connection.cursor() as cursor:
                cursor.execute(sql.SQL("set local statement_timeout = {}").format(sql.Literal(policy.statement_timeout_ms)))
                cursor.execute(sql.SQL("set local lock_timeout = {}").format(sql.Literal(policy.lock_timeout_ms)))
                # Lock every declared relation before reading. AccessShare blocks dbt's table replacement,
                # while ordinary ingestion inserts/updates continue under the MVCC snapshot.
                pinned = relations(manifest, analysis_ids)
                for schema, name in pinned:
                    cursor.execute(sql.SQL("lock table {}.{} in access share mode").format(sql.Identifier(schema), sql.Identifier(name)))
                cursor.execute("select txid_current_snapshot()::text, transaction_timestamp(), current_database()")
                snapshot, started, database = cursor.fetchone()
                results.context = {"isolation": "repeatable read", "snapshot": snapshot,
                                   "started_at": utc_iso(started), "database": database,
                                   "locked_relations": [f"{schema}.{name}" for schema, name in pinned],
                                   "model_builds": model_builds(cursor, manifest, analysis_ids)}
                generations = {}
                for schema, name in pinned:
                    cursor.execute("select c.oid, c.relfilenode, c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace "
                                   "where n.nspname=%s and c.relname=%s", (schema, name))
                    oid, filenode, kind = cursor.fetchone()
                    generations[f"{schema}.{name}"] = {"oid": oid, "relfilenode": filenode, "kind": kind}
                results.context["relation_generations"] = generations
                last_runs = {}
                for source in inputs:
                    cursor.execute("select finished_at, records_written, dagster_run_id from ops.ingestion_runs "
                                   "where source = %s and table_name = %s and succeeded order by finished_at desc limit 1",
                                   (source.source, source.table))
                    row = cursor.fetchone()
                    last_runs[source] = LastRun(*row) if row else None
                dead_letters = {source: count_dead_letters(cursor, source.source_table) for source in inputs}
            for uid in analysis_ids:
                node = manifest["nodes"][uid]
                path = Path(results.temporary.name) / f"{node['name']}.csv"
                preview, count = [], 0
                with connection.cursor(name=f"bj_{uuid4().hex}") as cursor:
                    cursor.itersize = policy.fetch_size
                    cursor.execute(node["compiled_code"])
                    # PostgreSQL describes a named cursor after its first fetch, not DECLARE.
                    batch = cursor.fetchmany(policy.fetch_size)
                    if cursor.description is None:
                        raise BadInput(f"analysis {node['name']} returned no columns: an analysis must be a select")
                    columns = [column.name for column in cursor.description]
                    expected = expected_columns.get(node["name"])
                    expected_names = [c if isinstance(c, str) else c["name"] for c in expected] if expected is not None else None
                    if expected_names is not None and columns != expected_names:
                        raise BadInput(f"analysis {node['name']} columns {columns} do not match expected_columns {expected}")
                    if expected is not None:
                        with connection.cursor() as types:
                            for contract, column in zip(expected, cursor.description):
                                if isinstance(contract, dict):
                                    types.execute("select typname, format_type(oid, null) from pg_type where oid = %s", (column.type_code,))
                                    actual = types.fetchone()
                                    if contract["type"] not in actual:
                                        raise BadInput(f"analysis {node['name']} column {column.name} type {actual[0]} does not match {contract['type']}")
                    keys = grain.get(node["name"], [])
                    missing = set(keys) - set(columns)
                    if missing:
                        raise BadInput(f"analysis {node['name']} grain columns are missing: {', '.join(sorted(missing))}")
                    key_indices = [columns.index(key) for key in keys]
                    with closing(sqlite3.connect(Path(results.temporary.name) / f"{node['name']}-grain.sqlite")) as unique, path.open("w", newline="", encoding="utf-8") as file:
                        if keys:
                            unique.execute("create table seen (key text primary key)")
                        writer = csv.writer(file, lineterminator="\n")
                        writer.writerow(columns)
                        while batch:
                            count += len(batch)
                            if policy.max_rows and count > policy.max_rows:
                                raise BadInput(f"analysis {node['name']} exceeded execution.max_rows={policy.max_rows}; no answer was published")
                            if len(preview) < 2:
                                preview.extend(batch[:2-len(preview)])
                            if keys:
                                try:
                                    unique.executemany("insert into seen values (?)", [(json.dumps(grain_key([row[i] for i in key_indices]), separators=(",", ":")),) for row in batch])
                                except sqlite3.IntegrityError:
                                    raise BadInput(f"analysis {node['name']} returned duplicate grain {keys}; no answer was published") from None
                            writer.writerows([cell_text(value) for value in row] for row in batch)
                            batch = cursor.fetchmany(policy.fetch_size)
                results.append(Result(node["name"], node["compiled_code"], columns, preview, path, count))
            connection.rollback()
        return results, dead_letters, last_runs
    except psycopg2.Error as error:
        results.close()
        raise BadInput(f"could not read analysis snapshot: {' '.join(str(error).split())}") from None
    except BaseException:
        results.close()
        raise
